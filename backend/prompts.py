"""Prompt templates for the language model.

A full word analysis is split into independent parts that run as parallel CLI calls:
generation time grows with answer length, so three short answers arrive much sooner
than one long one, and each part can be shown as soon as it is ready.
"""
from __future__ import annotations

ANALYSIS_PART_NAMES = ("core", "usage", "synonyms")
ANALYSIS_LANGUAGES = ("en", "ru")

LANGUAGE_INSTRUCTIONS = {
    "en": "Write all explanations in simple, clear English (B1-B2 level).",
    "ru": "Write all explanations in natural Russian (not word-for-word translation).",
}

PART_INSTRUCTIONS = {
    "core": """Return exactly this JSON structure:
{{
  "phrase": "the phrase in its dictionary form",
  "ipa": "IPA transcription, e.g. /ˈbɒt.əl.nek/",
  "part_of_speech": "noun / verb / phrasal verb / idiom / ...",
  "translation_ru": "best Russian translation for this context",
  "meaning_in_context": "what the phrase means in THIS sentence, 1-2 sentences",
  "word_breakdown": "how the word is built and why it means what it means"
}}
For word_breakdown: e.g. "bottleneck" = bottle + neck; the narrow neck of a bottle slows the
flow of liquid, so the word means the point that limits a whole process. If the parts are not
transparent, give a short etymology or a memory hook instead. Max 3 sentences.""",
    "usage": """Return exactly this JSON structure:
{{
  "usage_notes": "literal vs figurative senses, register (formal / informal / technical), typical collocations; mention if the literal sense is still used. Max 3 sentences.",
  "examples": [{{"en": "natural modern English sentence"{example_translation_field}}}]
}}
Give exactly 3 examples, different from the context sentence.""",
    "synonyms": """Return exactly this JSON structure:
{{
  "synonyms": [{{"word": "synonym", "nuance": "how it differs from the phrase, one short sentence"}}]
}}
Give up to 4 close synonyms.""",
}

ANALYSIS_PART_PROMPT_TEMPLATE = """You help a Russian-speaking learner who is reading an English book.
Analyse the phrase as it is used in the context sentence.
{language_instruction}
Return ONLY one JSON object, without markdown fences or any other text.

{part_instruction}

Phrase: <<<{phrase}>>>
Context sentence: <<<{context_sentence}>>>
"""


def build_phrase_part_prompt(part_name: str, language: str, phrase: str, context_sentence: str) -> str:
    part_instruction = PART_INSTRUCTIONS[part_name].format(
        example_translation_field=', "ru": "its Russian translation"' if language == "ru" else "",
    )
    return ANALYSIS_PART_PROMPT_TEMPLATE.format(
        language_instruction=LANGUAGE_INSTRUCTIONS[language],
        part_instruction=part_instruction,
        phrase=phrase,
        context_sentence=context_sentence or "(no context available)",
    )


SENTENCE_TRANSLATION_PROMPT_TEMPLATE = """Translate the English text into natural Russian.
Return ONLY one JSON object without markdown: {{"translation_ru": "..."}}

Text: <<<{source_text}>>>
"""


def build_sentence_translation_prompt(source_text: str) -> str:
    return SENTENCE_TRANSLATION_PROMPT_TEMPLATE.format(source_text=source_text)


SENTENCE_GRAMMAR_PROMPT_TEMPLATE = """You help a Russian-speaking learner (intermediate level) understand an English sentence
from a book. Explain its grammar so the learner could build a similar sentence.
{language_instruction}
Return ONLY one JSON object, without markdown fences or any other text, with exactly this structure:
{{
  "structure": "the skeleton of the sentence: main clause, subordinate clauses and how they connect, 2-3 sentences",
  "points": [{{"fragment": "exact words from the sentence", "explanation": "which construction / tense / form this is and why it is used here"}}],
  "simplified": "the same idea rewritten as one or two simple English sentences"
}}
Give 2-5 points, only for constructions that are genuinely useful to learn (tenses, modal verbs,
gerund vs infinitive, conditionals, relative clauses, phrasal verbs, inversion, ellipsis, etc.).
Keep "fragment" in English exactly as in the sentence.

Sentence: <<<{sentence}>>>
"""


def build_sentence_grammar_prompt(language: str, sentence: str) -> str:
    return SENTENCE_GRAMMAR_PROMPT_TEMPLATE.format(
        language_instruction=LANGUAGE_INSTRUCTIONS[language],
        sentence=sentence,
    )
