# PDF Word Reader

A local PDF reader for English books with an AI vocabulary assistant, built for Russian-speaking learners.
Select a word and get its translation, pronunciation and a context-aware explanation;
select a sentence and get its translation and, on request, a grammar breakdown.

The explanations come from **Claude through the Claude Code CLI**, so the reader runs on an existing
Claude subscription — no separate API key or billing.

## Features

- **Word or phrase (1–4 words)**
  - Instant: machine translation with alternatives by part of speech, IPA from a dictionary,
    text-to-speech (normal and slow) and a recorded native pronunciation when available.
  - A few seconds later, from Claude: meaning in *this* context, word breakdown
    (e.g. *bottleneck = bottle + neck*), literal vs figurative usage, examples and synonyms with nuances.
  - Explanations in **English or Russian** (toggle; the other language is generated on demand).
- **Sentence** — translation, plus a **grammar breakdown** button: structure, key constructions and a simplified version.
- **Drill-down** — select any English word inside an explanation, synonym list or example to analyse it, then go back.
- **Vocabulary** — save words together with their sentence; saved words are **highlighted in every book**;
  export to Anki (CSV).
- Remembers the last page and zoom per book; zoom keeps the current line in place.

## Requirements

- Windows 10/11 (the launcher scripts are `.bat`; the server itself is cross-platform)
- Python 3.10+
- [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and logged in (`claude -p "hi"` must work)
- Chrome or Edge, and internet access (PDF.js is loaded from a CDN; translation and Claude are online)

## Setup

1. Run `install.bat` once — installs `fastapi`, `uvicorn` and `httpx`.
2. Try it: `start_reader.bat "C:\path\to\book.pdf"`.
3. Optional: run `register_open_with.bat` to add **PDF Word Reader** to Explorer's *Open with* menu
   for `.pdf` files (current user only). `unregister_open_with.bat` removes it.

The reader opens in Chrome (Edge as a fallback). Set `OPEN_AS_APP_WINDOW = True` in `launcher.py`
to open it as a separate window without tabs. In Edge, text-to-speech uses the higher-quality
Microsoft *Natural* voices.

## How it works

```
Browser (PDF.js viewer + side panel)
        │  HTTP, 127.0.0.1:8765
        ▼
FastAPI server (started in the background by launcher.py)
 ├─ machine translation — Google / Microsoft public endpoints, with fallback and cooldown
 ├─ Free Dictionary API — IPA, definitions, recorded audio
 ├─ claude -p --model haiku — explanations, grammar (three parallel calls per word)
 └─ SQLite (data/reader.sqlite3) — caches and the saved vocabulary
```

Notes on the Claude calls:
- The prompt is sent through stdin with a minimal system prompt and no tools or MCP servers.
- Extended thinking is disabled (`MAX_THINKING_TOKENS=0`): for short JSON answers it multiplied
  the response time several times over.
- An analysis is split into three independent requests (meaning, usage, synonyms) that run in
  parallel and appear in the panel as each finishes.

## Project layout

```
backend/        FastAPI server, Claude CLI client, translation and dictionary clients, SQLite storage
frontend/       index.html, app.js (viewer, selection, panel state), side_panel.js (rendering),
                selection_context.js, saved_word_highlighter.js, speech.js, styles.css
launcher.py     starts the server if needed and opens the browser
*.bat           install / start / stop / register helpers for Windows
data/           local database, logs (git-ignored)
```

## Troubleshooting

- Server log: `data/server.log` (includes timing of every Claude call).
- After changing backend code: `stop_reader.bat`, then open a book again.
- Errors from Claude in the panel: check that `claude -p "hi"` works in a terminal.
