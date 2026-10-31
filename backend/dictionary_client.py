"""Free Dictionary API client: reliable IPA, a recorded pronunciation and plain definitions.

IPA is taken from a dictionary rather than from the language model because models
occasionally produce plausible-looking but wrong transcriptions.
"""
from __future__ import annotations

from urllib.parse import quote

import httpx

DICTIONARY_ENDPOINT = "https://api.dictionaryapi.dev/api/v2/entries/en/"
MAXIMUM_MEANINGS = 4
MAXIMUM_DEFINITIONS_PER_MEANING = 3
MAXIMUM_SYNONYMS = 8


def choose_pronunciation_audio_url(phonetic_variants: list[dict]) -> str | None:
    audio_urls = [phonetic_variant.get("audio") for phonetic_variant in phonetic_variants if phonetic_variant.get("audio")]
    # American recordings are preferred to match the default en-US speech synthesis voice.
    for audio_url in audio_urls:
        if "-us." in audio_url:
            return audio_url
    return audio_urls[0] if audio_urls else None


def parse_dictionary_entries(dictionary_entries: list) -> dict | None:
    if not isinstance(dictionary_entries, list) or not dictionary_entries:
        return None

    ipa_transcription = None
    all_phonetic_variants: list[dict] = []
    meanings = []
    synonyms: list[str] = []

    for dictionary_entry in dictionary_entries:
        if not isinstance(dictionary_entry, dict):
            continue
        if ipa_transcription is None and dictionary_entry.get("phonetic"):
            ipa_transcription = dictionary_entry["phonetic"]
        phonetic_variants = [variant for variant in dictionary_entry.get("phonetics", []) if isinstance(variant, dict)]
        all_phonetic_variants.extend(phonetic_variants)
        if ipa_transcription is None:
            for phonetic_variant in phonetic_variants:
                if phonetic_variant.get("text"):
                    ipa_transcription = phonetic_variant["text"]
                    break

        for meaning in dictionary_entry.get("meanings", []):
            meaning_definitions = meaning.get("definitions", [])
            meanings.append(
                {
                    "part_of_speech": meaning.get("partOfSpeech", ""),
                    "definitions": [
                        {"definition": definition.get("definition", ""), "example": definition.get("example")}
                        for definition in meaning_definitions[:MAXIMUM_DEFINITIONS_PER_MEANING]
                    ],
                }
            )
            candidate_synonyms = list(meaning.get("synonyms", []))
            for definition in meaning_definitions:
                candidate_synonyms.extend(definition.get("synonyms", []))
            for candidate_synonym in candidate_synonyms:
                if candidate_synonym not in synonyms:
                    synonyms.append(candidate_synonym)

    return {
        "ipa": ipa_transcription,
        "audio_url": choose_pronunciation_audio_url(all_phonetic_variants),
        "meanings": meanings[:MAXIMUM_MEANINGS],
        "synonyms": synonyms[:MAXIMUM_SYNONYMS],
    }


async def lookup_english_dictionary_entry(http_client: httpx.AsyncClient, phrase: str) -> dict | None:
    # A missing dictionary entry is normal for phrases and proper names, so every failure
    # here degrades to "no dictionary data" instead of an error for the user.
    try:
        dictionary_response = await http_client.get(DICTIONARY_ENDPOINT + quote(phrase.lower()))
    except httpx.HTTPError:
        return None
    if dictionary_response.status_code != 200:
        return None
    try:
        dictionary_entries = dictionary_response.json()
    except ValueError:
        return None
    return parse_dictionary_entries(dictionary_entries)
