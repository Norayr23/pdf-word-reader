"""SQLite persistence: lookup caches and the user's saved vocabulary."""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

from .config import DATA_DIRECTORY, DATABASE_FILE_PATH


@contextmanager
def open_database_connection():
    # A fresh connection per operation keeps the code safe when FastAPI runs handlers in
    # different threads; opening SQLite is cheap compared to the network calls around it.
    database_connection = sqlite3.connect(DATABASE_FILE_PATH)
    database_connection.row_factory = sqlite3.Row
    try:
        yield database_connection
        database_connection.commit()
    finally:
        database_connection.close()


def current_utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def normalize_phrase_for_cache(phrase: str) -> str:
    return " ".join(phrase.lower().split())


def initialize_database() -> None:
    DATA_DIRECTORY.mkdir(parents=True, exist_ok=True)
    with open_database_connection() as database_connection:
        database_connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS phrase_analysis_cache (
                normalized_phrase TEXT NOT NULL,
                context_sentence TEXT NOT NULL,
                analysis_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (normalized_phrase, context_sentence)
            );
            CREATE TABLE IF NOT EXISTS phrase_part_cache (
                normalized_phrase TEXT NOT NULL,
                context_sentence TEXT NOT NULL,
                language TEXT NOT NULL,
                part_name TEXT NOT NULL,
                part_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (normalized_phrase, context_sentence, language, part_name)
            );
            CREATE TABLE IF NOT EXISTS translation_cache (
                cache_key TEXT PRIMARY KEY,
                translation_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS saved_vocabulary (
                vocabulary_entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
                phrase TEXT NOT NULL,
                context_sentence TEXT NOT NULL,
                translation_ru TEXT NOT NULL,
                analysis_json TEXT,
                source_document_name TEXT,
                saved_at TEXT NOT NULL,
                UNIQUE (phrase, context_sentence)
            );
            """
        )


def load_cached_phrase_analysis(phrase: str, context_sentence: str) -> dict | None:
    with open_database_connection() as database_connection:
        cached_row = database_connection.execute(
            "SELECT analysis_json FROM phrase_analysis_cache "
            "WHERE normalized_phrase = ? AND context_sentence = ?",
            (normalize_phrase_for_cache(phrase), context_sentence),
        ).fetchone()
    if cached_row is None:
        return None
    return json.loads(cached_row["analysis_json"])


def store_phrase_analysis(phrase: str, context_sentence: str, analysis: dict) -> None:
    with open_database_connection() as database_connection:
        database_connection.execute(
            "INSERT OR REPLACE INTO phrase_analysis_cache "
            "(normalized_phrase, context_sentence, analysis_json, created_at) VALUES (?, ?, ?, ?)",
            (
                normalize_phrase_for_cache(phrase),
                context_sentence,
                json.dumps(analysis, ensure_ascii=False),
                current_utc_timestamp(),
            ),
        )


def load_cached_phrase_part(phrase: str, context_sentence: str, language: str, part_name: str) -> dict | None:
    with open_database_connection() as database_connection:
        cached_row = database_connection.execute(
            "SELECT part_json FROM phrase_part_cache "
            "WHERE normalized_phrase = ? AND context_sentence = ? AND language = ? AND part_name = ?",
            (normalize_phrase_for_cache(phrase), context_sentence, language, part_name),
        ).fetchone()
    if cached_row is None:
        return None
    return json.loads(cached_row["part_json"])


def store_phrase_part(phrase: str, context_sentence: str, language: str, part_name: str, part_result: dict) -> None:
    with open_database_connection() as database_connection:
        database_connection.execute(
            "INSERT OR REPLACE INTO phrase_part_cache "
            "(normalized_phrase, context_sentence, language, part_name, part_json, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                normalize_phrase_for_cache(phrase),
                context_sentence,
                language,
                part_name,
                json.dumps(part_result, ensure_ascii=False),
                current_utc_timestamp(),
            ),
        )


def load_cached_translation(cache_key: str) -> dict | None:
    with open_database_connection() as database_connection:
        cached_row = database_connection.execute(
            "SELECT translation_json FROM translation_cache WHERE cache_key = ?",
            (cache_key,),
        ).fetchone()
    if cached_row is None:
        return None
    return json.loads(cached_row["translation_json"])


def store_translation(cache_key: str, translation: dict) -> None:
    with open_database_connection() as database_connection:
        database_connection.execute(
            "INSERT OR REPLACE INTO translation_cache (cache_key, translation_json, created_at) "
            "VALUES (?, ?, ?)",
            (cache_key, json.dumps(translation, ensure_ascii=False), current_utc_timestamp()),
        )


def save_vocabulary_entry(
    phrase: str,
    context_sentence: str,
    translation_ru: str,
    analysis: dict | None,
    source_document_name: str | None,
) -> None:
    # Saving the same word in the same sentence twice updates the entry instead of
    # creating a duplicate flashcard.
    with open_database_connection() as database_connection:
        database_connection.execute(
            """
            INSERT INTO saved_vocabulary
                (phrase, context_sentence, translation_ru, analysis_json, source_document_name, saved_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (phrase, context_sentence) DO UPDATE SET
                translation_ru = excluded.translation_ru,
                analysis_json = excluded.analysis_json,
                source_document_name = excluded.source_document_name,
                saved_at = excluded.saved_at
            """,
            (
                phrase,
                context_sentence,
                translation_ru,
                json.dumps(analysis, ensure_ascii=False) if analysis is not None else None,
                source_document_name,
                current_utc_timestamp(),
            ),
        )


def list_vocabulary_entries() -> list[dict]:
    with open_database_connection() as database_connection:
        vocabulary_rows = database_connection.execute(
            "SELECT * FROM saved_vocabulary ORDER BY saved_at DESC"
        ).fetchall()
    vocabulary_entries = []
    for vocabulary_row in vocabulary_rows:
        vocabulary_entry = dict(vocabulary_row)
        stored_analysis_json = vocabulary_entry.pop("analysis_json")
        vocabulary_entry["analysis"] = json.loads(stored_analysis_json) if stored_analysis_json else None
        vocabulary_entries.append(vocabulary_entry)
    return vocabulary_entries


def delete_vocabulary_entry(vocabulary_entry_id: int) -> bool:
    with open_database_connection() as database_connection:
        deletion_cursor = database_connection.execute(
            "DELETE FROM saved_vocabulary WHERE vocabulary_entry_id = ?",
            (vocabulary_entry_id,),
        )
    return deletion_cursor.rowcount > 0
