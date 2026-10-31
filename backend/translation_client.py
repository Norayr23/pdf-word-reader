"""Instant machine translation without an API key.

Claude is too slow for sentence translation while reading, so sentences and the first
"quick" layer of a word lookup go through a machine translator instead. The primary
provider is the Microsoft service behind Edge's built-in page translation; Google's
public endpoint is only a fallback because it rate-limits aggressively (HTTP 429),
especially behind VPNs.
"""
from __future__ import annotations

import time

import httpx

from .config import SOURCE_LANGUAGE_CODE, TARGET_LANGUAGE_CODE

GOOGLE_TRANSLATE_ENDPOINT = "https://translate.googleapis.com/translate_a/single"
# Endpoint used by Google's own Chrome dictionary extension; it has separate rate limits
# from the gtx endpoint, so it often still answers when gtx returns 429.
GOOGLE_CHROME_EXTENSION_ENDPOINT = "https://clients5.google.com/translate_a/t"
# A provider that answered 429 or failed is skipped for this long, so one blocked provider
# does not add its timeout to every following lookup.
PROVIDER_COOLDOWN_SECONDS = 120
MICROSOFT_TOKEN_ENDPOINT = "https://edge.microsoft.com/translate/auth"
MICROSOFT_TRANSLATE_ENDPOINT = "https://api.cognitive.microsofttranslator.com/translate"
MICROSOFT_DICTIONARY_ENDPOINT = "https://api.cognitive.microsofttranslator.com/dictionary/lookup"
# The token issued for Edge lives about ten minutes; renewing earlier avoids requests
# failing at the edge of its lifetime.
MICROSOFT_TOKEN_LIFETIME_SECONDS = 8 * 60
MAXIMUM_WORDS_FOR_DICTIONARY_LOOKUP = 3
MAXIMUM_ALTERNATIVES_PER_PART_OF_SPEECH = 6


class TranslationServiceError(Exception):
    pass


def parse_google_translate_payload(response_payload: list, include_dictionary_alternatives: bool) -> dict:
    # The endpoint returns positional arrays rather than named fields, so every access is
    # guarded: the format is unofficial and may shift slightly between responses.
    translated_segments = response_payload[0] if response_payload and isinstance(response_payload[0], list) else []
    translated_text = "".join(
        translated_segment[0]
        for translated_segment in translated_segments
        if isinstance(translated_segment, list) and translated_segment and isinstance(translated_segment[0], str)
    )

    alternatives_by_part_of_speech = []
    has_dictionary_block = len(response_payload) > 1 and isinstance(response_payload[1], list)
    if include_dictionary_alternatives and has_dictionary_block:
        for dictionary_entry in response_payload[1]:
            is_well_formed_entry = (
                isinstance(dictionary_entry, list)
                and len(dictionary_entry) >= 2
                and isinstance(dictionary_entry[1], list)
            )
            if not is_well_formed_entry:
                continue
            alternatives_by_part_of_speech.append(
                {
                    "part_of_speech": dictionary_entry[0] or "",
                    "translations": dictionary_entry[1][:MAXIMUM_ALTERNATIVES_PER_PART_OF_SPEECH],
                }
            )

    return {
        "translated_text": translated_text.strip(),
        "alternatives_by_part_of_speech": alternatives_by_part_of_speech,
    }


class MicrosoftTokenCache:
    def __init__(self) -> None:
        self.access_token: str | None = None
        self.expires_at_monotonic = 0.0

    async def get_access_token(self, http_client: httpx.AsyncClient) -> str:
        if self.access_token and time.monotonic() < self.expires_at_monotonic:
            return self.access_token
        token_response = await http_client.get(MICROSOFT_TOKEN_ENDPOINT)
        token_response.raise_for_status()
        self.access_token = token_response.text.strip()
        self.expires_at_monotonic = time.monotonic() + MICROSOFT_TOKEN_LIFETIME_SECONDS
        return self.access_token

    def invalidate(self) -> None:
        self.access_token = None


microsoft_token_cache = MicrosoftTokenCache()


def parse_microsoft_dictionary_payload(response_payload: list) -> list[dict]:
    translations_by_part_of_speech: dict[str, list[str]] = {}
    if not response_payload or not isinstance(response_payload[0], dict):
        return []
    for dictionary_translation in response_payload[0].get("translations", []):
        part_of_speech = str(dictionary_translation.get("posTag", "")).lower()
        target_word = dictionary_translation.get("displayTarget")
        if not target_word:
            continue
        part_of_speech_translations = translations_by_part_of_speech.setdefault(part_of_speech, [])
        if target_word not in part_of_speech_translations:
            part_of_speech_translations.append(target_word)
    return [
        {"part_of_speech": part_of_speech, "translations": target_words[:MAXIMUM_ALTERNATIVES_PER_PART_OF_SPEECH]}
        for part_of_speech, target_words in translations_by_part_of_speech.items()
    ]


async def post_to_microsoft_translator(http_client: httpx.AsyncClient, endpoint_url: str, source_text: str) -> list:
    query_parameters = {"api-version": "3.0", "from": SOURCE_LANGUAGE_CODE, "to": TARGET_LANGUAGE_CODE}
    for attempt_number in range(2):
        access_token = await microsoft_token_cache.get_access_token(http_client)
        translator_response = await http_client.post(
            endpoint_url,
            params=query_parameters,
            headers={"Authorization": f"Bearer {access_token}"},
            json=[{"Text": source_text}],
        )
        # An expired or revoked token gets one retry with a fresh token.
        if translator_response.status_code == 401 and attempt_number == 0:
            microsoft_token_cache.invalidate()
            continue
        translator_response.raise_for_status()
        return translator_response.json()
    raise TranslationServiceError("Microsoft translator rejected the token twice")


async def translate_with_microsoft(
    http_client: httpx.AsyncClient,
    source_text: str,
    include_dictionary_alternatives: bool,
) -> dict:
    translation_payload = await post_to_microsoft_translator(http_client, MICROSOFT_TRANSLATE_ENDPOINT, source_text)
    translated_text = translation_payload[0]["translations"][0]["text"]

    alternatives_by_part_of_speech: list[dict] = []
    is_short_enough_for_dictionary = len(source_text.split()) <= MAXIMUM_WORDS_FOR_DICTIONARY_LOOKUP
    if include_dictionary_alternatives and is_short_enough_for_dictionary:
        # Alternatives are a bonus: a failed dictionary lookup must not hide the translation.
        try:
            dictionary_payload = await post_to_microsoft_translator(http_client, MICROSOFT_DICTIONARY_ENDPOINT, source_text)
            alternatives_by_part_of_speech = parse_microsoft_dictionary_payload(dictionary_payload)
        except (httpx.HTTPError, ValueError, KeyError, IndexError, TranslationServiceError):
            alternatives_by_part_of_speech = []

    return {
        "translated_text": str(translated_text).strip(),
        "alternatives_by_part_of_speech": alternatives_by_part_of_speech,
    }


async def translate_with_google(
    http_client: httpx.AsyncClient,
    source_text: str,
    include_dictionary_alternatives: bool,
) -> dict:
    query_parameters = [
        ("client", "gtx"),
        ("sl", SOURCE_LANGUAGE_CODE),
        ("tl", TARGET_LANGUAGE_CODE),
        ("dt", "t"),
        ("q", source_text),
    ]
    if include_dictionary_alternatives:
        # "bd" asks for the dictionary block: alternative translations grouped by part of speech.
        query_parameters.append(("dt", "bd"))
    translation_response = await http_client.get(GOOGLE_TRANSLATE_ENDPOINT, params=query_parameters)
    translation_response.raise_for_status()
    response_payload = translation_response.json()
    if not isinstance(response_payload, list):
        raise TranslationServiceError("Unexpected Google response format")
    return parse_google_translate_payload(response_payload, include_dictionary_alternatives)


def parse_google_chrome_extension_payload(response_payload) -> str:
    # The response is either a list of strings or a list of [translation, detected_language]
    # pairs, depending on how many sentences the text contains.
    if isinstance(response_payload, str):
        return response_payload
    if not isinstance(response_payload, list):
        return ""
    translated_parts = []
    for response_item in response_payload:
        if isinstance(response_item, str):
            translated_parts.append(response_item)
        elif isinstance(response_item, list) and response_item and isinstance(response_item[0], str):
            translated_parts.append(response_item[0])
    return " ".join(translated_parts)


async def translate_with_google_chrome_extension(
    http_client: httpx.AsyncClient,
    source_text: str,
    include_dictionary_alternatives: bool,
) -> dict:
    translation_response = await http_client.get(
        GOOGLE_CHROME_EXTENSION_ENDPOINT,
        params={"client": "dict-chrome-ex", "sl": SOURCE_LANGUAGE_CODE, "tl": TARGET_LANGUAGE_CODE, "q": source_text},
    )
    translation_response.raise_for_status()
    return {
        "translated_text": parse_google_chrome_extension_payload(translation_response.json()).strip(),
        "alternatives_by_part_of_speech": [],
    }


provider_unavailable_until_monotonic: dict[str, float] = {}

TRANSLATION_PROVIDERS = (
    ("Google", translate_with_google),
    ("GoogleChromeExtension", translate_with_google_chrome_extension),
    ("Microsoft", translate_with_microsoft),
)


async def translate_english_text(
    http_client: httpx.AsyncClient,
    source_text: str,
    include_dictionary_alternatives: bool,
) -> dict:
    provider_failures = []
    for provider_name, translate_with_provider in TRANSLATION_PROVIDERS:
        if time.monotonic() < provider_unavailable_until_monotonic.get(provider_name, 0.0):
            provider_failures.append(f"{provider_name}: cooling down")
            continue
        try:
            translation = await translate_with_provider(http_client, source_text, include_dictionary_alternatives)
        except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError, TranslationServiceError) as provider_error:
            provider_status = getattr(getattr(provider_error, "response", None), "status_code", None)
            provider_failures.append(f"{provider_name}: {provider_status or type(provider_error).__name__}")
            provider_unavailable_until_monotonic[provider_name] = time.monotonic() + PROVIDER_COOLDOWN_SECONDS
            continue
        if translation["translated_text"]:
            return translation
        provider_failures.append(f"{provider_name}: empty result")
    raise TranslationServiceError("; ".join(provider_failures))
