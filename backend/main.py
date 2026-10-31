"""HTTP server: serves the reader UI, local PDF files and the lookup API."""
from __future__ import annotations

import asyncio
import csv
import io
import os
import subprocess
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import storage
from .claude_cli_client import ClaudeCliError, ask_claude_for_json
from .config import EXTERNAL_HTTP_TIMEOUT_SECONDS, FRONTEND_DIRECTORY
from .dictionary_client import lookup_english_dictionary_entry
from .prompts import (
    ANALYSIS_LANGUAGES,
    ANALYSIS_PART_NAMES,
    build_phrase_part_prompt,
    build_sentence_grammar_prompt,
    build_sentence_translation_prompt,
)
from .translation_client import TranslationServiceError, translate_english_text

# Requests carrying this header cannot be sent cross-origin without a CORS preflight,
# which this server never approves, so other websites cannot shut the server down.
LOCAL_CLIENT_HEADER_NAME = "x-pdf-word-reader"


@asynccontextmanager
async def application_lifespan(application: FastAPI):
    storage.initialize_database()
    application.state.http_client = httpx.AsyncClient(
        timeout=EXTERNAL_HTTP_TIMEOUT_SECONDS,
        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) PdfWordReader/1.0"},
        follow_redirects=True,
    )
    yield
    await application.state.http_client.aclose()


app = FastAPI(title="PDF Word Reader", lifespan=application_lifespan)
# Rejecting foreign Host headers blocks DNS-rebinding pages from reading local PDFs
# through /api/document.
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])


@app.middleware("http")
async def require_revalidation_of_frontend_files(request: Request, call_next):
    response = await call_next(request)
    # Without this, browsers reuse cached JS/CSS heuristically and code updates do not appear
    # until a hard refresh; "no-cache" still allows cheap 304 answers via ETag.
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


class QuickLookupRequest(BaseModel):
    phrase: str = Field(min_length=1, max_length=200)


class PhrasePartRequest(BaseModel):
    phrase: str = Field(min_length=1, max_length=200)
    context_sentence: str = Field(default="", max_length=2000)
    language: str = Field(pattern="^(" + "|".join(ANALYSIS_LANGUAGES) + ")$")
    part_name: str = Field(pattern="^(" + "|".join(ANALYSIS_PART_NAMES) + ")$")


class SentenceGrammarRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    language: str = Field(pattern="^(" + "|".join(ANALYSIS_LANGUAGES) + ")$")


class SentenceTranslationRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)


class VocabularyEntryRequest(BaseModel):
    phrase: str = Field(min_length=1, max_length=200)
    context_sentence: str = ""
    translation_ru: str = ""
    analysis: dict | None = None
    source_document_name: str | None = None


def collapse_whitespace(text: str) -> str:
    return " ".join(text.split())


async def translate_with_cache(http_client: httpx.AsyncClient, source_text: str, include_alternatives: bool) -> dict:
    cache_key = f"{'word' if include_alternatives else 'text'}:{source_text}"
    cached_translation = storage.load_cached_translation(cache_key)
    if cached_translation is not None:
        return cached_translation
    translation = await translate_english_text(http_client, source_text, include_alternatives)
    if translation["translated_text"]:
        storage.store_translation(cache_key, translation)
    return translation


# Identical requests that arrive while Claude is still working share one CLI call instead
# of starting a second process.
pending_phrase_part_tasks: dict[tuple[str, str, str, str], asyncio.Task] = {}


async def analyse_phrase_part_and_store(phrase: str, context_sentence: str, language: str, part_name: str) -> dict:
    part_result = await ask_claude_for_json(build_phrase_part_prompt(part_name, language, phrase, context_sentence))
    storage.store_phrase_part(phrase, context_sentence, language, part_name, part_result)
    return part_result


@app.get("/api/health")
async def report_health():
    return {"status": "ok"}


@app.get("/api/document")
async def serve_pdf_document(path: str = Query(min_length=1)):
    document_path = Path(path)
    if document_path.suffix.lower() != ".pdf" or not document_path.is_file():
        raise HTTPException(status_code=404, detail="PDF file not found")
    return FileResponse(document_path, media_type="application/pdf")


@app.post("/api/quick-lookup")
async def quick_lookup(request_body: QuickLookupRequest, request: Request):
    phrase = collapse_whitespace(request_body.phrase)
    http_client = request.app.state.http_client
    translation_result, dictionary_result = await asyncio.gather(
        translate_with_cache(http_client, phrase, include_alternatives=True),
        lookup_english_dictionary_entry(http_client, phrase),
        return_exceptions=True,
    )
    translation_error = None
    if isinstance(translation_result, Exception):
        translation_error = str(translation_result)
        translation_result = None
    if isinstance(dictionary_result, Exception):
        dictionary_result = None
    return {
        "phrase": phrase,
        "translation": translation_result,
        "translation_error": translation_error,
        "dictionary": dictionary_result,
    }


@app.post("/api/phrase-part")
async def analyse_phrase_part(request_body: PhrasePartRequest):
    phrase = collapse_whitespace(request_body.phrase)
    context_sentence = collapse_whitespace(request_body.context_sentence)
    language = request_body.language
    part_name = request_body.part_name

    cached_part = storage.load_cached_phrase_part(phrase, context_sentence, language, part_name)
    if cached_part is not None:
        return {"result": cached_part, "from_cache": True}

    task_key = (storage.normalize_phrase_for_cache(phrase), context_sentence, language, part_name)
    part_task = pending_phrase_part_tasks.get(task_key)
    if part_task is None:
        part_task = asyncio.create_task(analyse_phrase_part_and_store(phrase, context_sentence, language, part_name))
        pending_phrase_part_tasks[task_key] = part_task
        part_task.add_done_callback(lambda finished_task: pending_phrase_part_tasks.pop(task_key, None))

    try:
        # shield() keeps the Claude call running when the browser drops the request (the user
        # selected another word), so the finished answer still lands in the cache.
        part_result = await asyncio.shield(part_task)
    except ClaudeCliError as claude_error:
        raise HTTPException(status_code=502, detail=str(claude_error)) from claude_error
    return {"result": part_result, "from_cache": False}


# The grammar explanation reuses the per-part cache: the sentence plays the role of the phrase,
# the context is empty and the part name is "grammar".
GRAMMAR_PART_NAME = "grammar"


async def explain_grammar_and_store(sentence: str, language: str) -> dict:
    grammar_result = await ask_claude_for_json(build_sentence_grammar_prompt(language, sentence))
    storage.store_phrase_part(sentence, "", language, GRAMMAR_PART_NAME, grammar_result)
    return grammar_result


@app.post("/api/sentence-grammar")
async def explain_sentence_grammar(request_body: SentenceGrammarRequest):
    sentence = collapse_whitespace(request_body.text)
    language = request_body.language
    cached_grammar = storage.load_cached_phrase_part(sentence, "", language, GRAMMAR_PART_NAME)
    if cached_grammar is not None:
        return {"result": cached_grammar, "from_cache": True}

    task_key = (storage.normalize_phrase_for_cache(sentence), "", language, GRAMMAR_PART_NAME)
    grammar_task = pending_phrase_part_tasks.get(task_key)
    if grammar_task is None:
        grammar_task = asyncio.create_task(explain_grammar_and_store(sentence, language))
        pending_phrase_part_tasks[task_key] = grammar_task
        grammar_task.add_done_callback(lambda finished_task: pending_phrase_part_tasks.pop(task_key, None))
    try:
        grammar_result = await asyncio.shield(grammar_task)
    except ClaudeCliError as claude_error:
        raise HTTPException(status_code=502, detail=str(claude_error)) from claude_error
    return {"result": grammar_result, "from_cache": False}


@app.post("/api/translate-sentence")
async def translate_sentence(request_body: SentenceTranslationRequest, request: Request):
    source_text = collapse_whitespace(request_body.text)
    try:
        translation = await translate_with_cache(request.app.state.http_client, source_text, include_alternatives=False)
        return {"source_text": source_text, "translated_text": translation["translated_text"], "provider": "machine"}
    except TranslationServiceError as translation_error:
        machine_translation_error = translation_error

    # Every free translator refused (typically rate limits behind a VPN); a slower Claude
    # translation is better than no translation at all.
    try:
        claude_answer = await ask_claude_for_json(build_sentence_translation_prompt(source_text))
    except ClaudeCliError as claude_error:
        raise HTTPException(
            status_code=502,
            detail=f"{machine_translation_error}; Claude: {claude_error}",
        ) from claude_error
    translated_text = str(claude_answer.get("translation_ru", "")).strip()
    if translated_text:
        storage.store_translation(f"text:{source_text}", {"translated_text": translated_text, "alternatives_by_part_of_speech": []})
    return {"source_text": source_text, "translated_text": translated_text, "provider": "claude"}


@app.post("/api/vocabulary")
async def save_vocabulary(request_body: VocabularyEntryRequest):
    storage.save_vocabulary_entry(
        phrase=collapse_whitespace(request_body.phrase),
        context_sentence=collapse_whitespace(request_body.context_sentence),
        translation_ru=request_body.translation_ru,
        analysis=request_body.analysis,
        source_document_name=request_body.source_document_name,
    )
    return {"status": "saved"}


@app.get("/api/vocabulary")
async def list_vocabulary():
    return {"entries": storage.list_vocabulary_entries()}


@app.delete("/api/vocabulary/{vocabulary_entry_id}")
async def delete_vocabulary(vocabulary_entry_id: int):
    if not storage.delete_vocabulary_entry(vocabulary_entry_id):
        raise HTTPException(status_code=404, detail="Entry not found")
    return {"status": "deleted"}


@app.get("/api/vocabulary/export.csv")
async def export_vocabulary_for_anki():
    # Two columns (front, back) with HTML inside is the simplest format Anki imports
    # without any field mapping.
    csv_buffer = io.StringIO()
    csv_writer = csv.writer(csv_buffer)
    for vocabulary_entry in storage.list_vocabulary_entries():
        # Saved analysis has the shape {language: {part_name: part_result}}.
        analysis_by_language = vocabulary_entry["analysis"] or {}
        core_part = (analysis_by_language.get("ru") or {}).get("core") or (analysis_by_language.get("en") or {}).get("core") or {}
        card_front = vocabulary_entry["phrase"]
        if vocabulary_entry["context_sentence"]:
            card_front += f"<br><br><i>{vocabulary_entry['context_sentence']}</i>"
        card_back_parts = [part for part in (core_part.get("ipa"), vocabulary_entry["translation_ru"]) if part]
        if isinstance(core_part.get("meaning_in_context"), str):
            card_back_parts.append(core_part["meaning_in_context"])
        csv_writer.writerow([card_front, "<br>".join(card_back_parts)])
    return Response(
        content=csv_buffer.getvalue().encode("utf-8-sig"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="vocabulary_anki.csv"'},
    )


@app.post("/api/shutdown")
async def shut_down_server(request: Request):
    if request.headers.get(LOCAL_CLIENT_HEADER_NAME) != "1":
        raise HTTPException(status_code=403, detail="Forbidden")
    # The delay lets this response reach the caller before the process exits.
    asyncio.get_running_loop().call_later(0.3, os._exit, 0)
    return {"status": "shutting down"}


@app.post("/api/restart")
async def restart_server(request: Request):
    if request.headers.get(LOCAL_CLIENT_HEADER_NAME) != "1":
        raise HTTPException(status_code=403, detail="Forbidden")
    # A detached launcher waits until this process has released the port and then starts a
    # fresh server, so code changes can be applied without the user touching a terminal.
    launcher_path = Path(__file__).resolve().parent.parent / "launcher.py"
    process_creation_flags = 0
    if sys.platform == "win32":
        process_creation_flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS
    subprocess.Popen(
        [sys.executable, str(launcher_path), "--restart-server"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=process_creation_flags,
    )
    asyncio.get_running_loop().call_later(0.3, os._exit, 0)
    return {"status": "restarting"}


# Mounted last so that /api routes take precedence over static files.
app.mount("/", StaticFiles(directory=FRONTEND_DIRECTORY, html=True), name="frontend")
