"""Runs Claude Code in non-interactive mode, so lookups use the existing Claude subscription
instead of a separately billed API key."""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from .config import (
    CLAUDE_CALL_TIMEOUT_SECONDS,
    CLAUDE_ISOLATED_WORKING_DIRECTORY,
    CLAUDE_MODEL_ALIAS,
    CLAUDE_SPEED_ARGUMENTS,
    MAXIMUM_PARALLEL_CLAUDE_CALLS,
)


class ClaudeCliError(Exception):
    pass


claude_call_semaphore = asyncio.Semaphore(MAXIMUM_PARALLEL_CLAUDE_CALLS)

# Becomes False after the installed CLI rejects one of the speed flags, so the failing
# attempt is paid only once per server run.
speed_arguments_are_supported = True


def locate_claude_executable() -> str:
    executable_path = shutil.which("claude")
    if executable_path:
        return executable_path
    # A server started from Explorer via "Open with" may not inherit a PATH that contains
    # the CLI, so the standard install locations are checked explicitly.
    candidate_executable_paths = [
        Path.home() / ".local" / "bin" / "claude.exe",
        Path(os.environ.get("APPDATA", "")) / "npm" / "claude.cmd",
    ]
    for candidate_executable_path in candidate_executable_paths:
        if candidate_executable_path.is_file():
            return str(candidate_executable_path)
    raise ClaudeCliError("Claude CLI not found. Check that `claude` works in a terminal.")


def extract_result_text_from_cli_output(cli_standard_output: str) -> str:
    try:
        parsed_output = json.loads(cli_standard_output)
    except json.JSONDecodeError as decode_error:
        raise ClaudeCliError(f"Unexpected Claude CLI output: {cli_standard_output[:300]}") from decode_error

    # Depending on the CLI version, --output-format json yields either one result object
    # or the whole message list with the result object last.
    if isinstance(parsed_output, list):
        result_envelopes = [item for item in parsed_output if isinstance(item, dict) and item.get("type") == "result"]
        if not result_envelopes:
            raise ClaudeCliError("Claude CLI output contains no result message")
        result_envelope = result_envelopes[-1]
    elif isinstance(parsed_output, dict):
        result_envelope = parsed_output
    else:
        raise ClaudeCliError("Unexpected Claude CLI output structure")

    print(
        f"[claude] cli reported duration_ms={result_envelope.get('duration_ms')} "
        f"duration_api_ms={result_envelope.get('duration_api_ms')} "
        f"output_tokens={(result_envelope.get('usage') or {}).get('output_tokens')} model_usage={list((result_envelope.get('modelUsage') or {}).keys())}",
        flush=True,
    )
    if result_envelope.get("is_error"):
        raise ClaudeCliError(f"Claude returned an error: {str(result_envelope.get('result'))[:500]}")
    return str(result_envelope.get("result", ""))


def extract_json_object(model_response_text: str) -> dict:
    # Models sometimes wrap JSON in markdown fences or add a sentence around it; taking the
    # outermost braces is more robust than requiring a perfectly clean answer.
    first_brace_index = model_response_text.find("{")
    last_brace_index = model_response_text.rfind("}")
    if first_brace_index == -1 or last_brace_index <= first_brace_index:
        raise ClaudeCliError("Claude answer contains no JSON object")
    try:
        parsed_object = json.loads(model_response_text[first_brace_index:last_brace_index + 1])
    except json.JSONDecodeError as decode_error:
        raise ClaudeCliError(f"Claude answer is not valid JSON: {decode_error}") from decode_error
    if not isinstance(parsed_object, dict):
        raise ClaudeCliError("Claude answer JSON is not an object")
    return parsed_object


def run_claude_process(prompt_text: str, use_speed_arguments: bool) -> subprocess.CompletedProcess:
    command_arguments = [locate_claude_executable(), "-p", "--model", CLAUDE_MODEL_ALIAS, "--output-format", "json"]
    if use_speed_arguments:
        command_arguments.extend(CLAUDE_SPEED_ARGUMENTS)

    CLAUDE_ISOLATED_WORKING_DIRECTORY.mkdir(parents=True, exist_ok=True)
    # Without this flag every lookup would flash a console window, because the server
    # itself runs without a console.
    process_creation_flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

    # Claude Code enables extended thinking by default; for a short JSON answer it multiplies
    # the generated tokens (logs showed 1-6k output tokens for ~200-token answers) and with
    # them the waiting time. A zero budget turns thinking off.
    process_environment = dict(os.environ)
    process_environment["MAX_THINKING_TOKENS"] = "0"

    try:
        # The prompt goes through stdin rather than the command line to avoid Windows
        # quoting problems and command-length limits with long context sentences.
        return subprocess.run(
            command_arguments,
            input=prompt_text,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=CLAUDE_ISOLATED_WORKING_DIRECTORY,
            timeout=CLAUDE_CALL_TIMEOUT_SECONDS,
            creationflags=process_creation_flags,
            env=process_environment,
        )
    except subprocess.TimeoutExpired as timeout_error:
        raise ClaudeCliError(f"Claude CLI did not answer within {CLAUDE_CALL_TIMEOUT_SECONDS} s") from timeout_error
    except OSError as start_error:
        raise ClaudeCliError(f"Could not start Claude CLI: {start_error}") from start_error


def describe_cli_failure(completed_process: subprocess.CompletedProcess) -> str:
    # With --output-format json the reason is inside the JSON envelope ("result" or
    # "errors"), after a long block of usage statistics; showing the raw text cut it off.
    raw_output = (completed_process.stdout or "").strip()
    try:
        parsed_output = json.loads(raw_output)
    except json.JSONDecodeError:
        return ((completed_process.stderr or "").strip() or raw_output)[:500]
    result_envelope = parsed_output[-1] if isinstance(parsed_output, list) and parsed_output else parsed_output
    if not isinstance(result_envelope, dict):
        return raw_output[:500]
    failure_reasons = [
        str(result_envelope.get(field_name))
        for field_name in ("result", "errors", "subtype")
        if result_envelope.get(field_name)
    ]
    return "; ".join(failure_reasons)[:500] or raw_output[:500]


def log_claude_timing(message_text: str) -> None:
    # print goes to data/server.log, where uvicorn's output is redirected by the launcher.
    print(f"[claude] {message_text}", flush=True)


def ask_claude_blocking(prompt_text: str) -> str:
    global speed_arguments_are_supported

    call_started_at = time.monotonic()
    completed_process = run_claude_process(prompt_text, speed_arguments_are_supported)
    log_claude_timing(
        f"first attempt: speed_args={speed_arguments_are_supported} exit={completed_process.returncode} "
        f"wall={time.monotonic() - call_started_at:.1f}s stderr={(completed_process.stderr or '').strip()[:300]!r}"
    )
    cli_error_output = (completed_process.stderr or "").lower()
    rejected_unknown_flag = completed_process.returncode != 0 and (
        "unknown option" in cli_error_output or "unknown argument" in cli_error_output
    )
    if speed_arguments_are_supported and rejected_unknown_flag:
        speed_arguments_are_supported = False
        retry_started_at = time.monotonic()
        completed_process = run_claude_process(prompt_text, use_speed_arguments=False)
        log_claude_timing(f"retry without speed args: exit={completed_process.returncode} wall={time.monotonic() - retry_started_at:.1f}s")

    if completed_process.returncode != 0:
        failure_description = describe_cli_failure(completed_process)
        log_claude_timing(f"failure: {failure_description}")
        # An expired login is the common case after a few days; the user can fix it in a
        # minute if the panel says what to do instead of showing the raw CLI message.
        if "authenticate" in failure_description.lower() or "login" in failure_description.lower():
            raise ClaudeCliError(
                "Claude Code не авторизован (истекла сессия входа). "
                "Откройте терминал, запустите `claude`, выполните /login и нажмите «Повторить». "
                f"[{failure_description}]"
            )
        raise ClaudeCliError(f"Claude CLI exited with code {completed_process.returncode}: {failure_description}")
    return extract_result_text_from_cli_output(completed_process.stdout)


async def ask_claude_for_json(prompt_text: str) -> dict:
    async with claude_call_semaphore:
        # subprocess.run in a worker thread works with any asyncio event loop on Windows,
        # unlike asyncio's own subprocess API which depends on the loop implementation.
        model_response_text = await asyncio.to_thread(ask_claude_blocking, prompt_text)
    return extract_json_object(model_response_text)
