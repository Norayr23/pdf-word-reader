"""Entry point for "Open with" and start_reader.bat.

Makes sure the local server is running (starting it in the background if needed) and
opens the reader in an Edge app window, optionally with a PDF path passed by Explorer.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

PROJECT_ROOT_DIRECTORY = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT_DIRECTORY))

from backend.config import DATA_DIRECTORY, SERVER_HOST, SERVER_LOG_FILE_PATH, SERVER_PORT  # noqa: E402

SERVER_BASE_URL = f"http://{SERVER_HOST}:{SERVER_PORT}"
SERVER_START_TIMEOUT_SECONDS = 20
SERVER_POLL_INTERVAL_SECONDS = 0.25


def show_error_message(message_text: str) -> None:
    # The launcher runs under pythonw without a console, so a message box is the only way
    # the user can see why the reader did not open.
    if sys.platform == "win32":
        import ctypes

        message_box_icon_error = 0x10
        ctypes.windll.user32.MessageBoxW(None, message_text, "PDF Word Reader", message_box_icon_error)
    else:
        print(message_text, file=sys.stderr)


def is_server_responding() -> bool:
    try:
        with urllib.request.urlopen(f"{SERVER_BASE_URL}/api/health", timeout=1) as health_response:
            return health_response.status == 200
    except OSError:
        return False


def start_server_in_background() -> None:
    DATA_DIRECTORY.mkdir(parents=True, exist_ok=True)
    server_log_file = open(SERVER_LOG_FILE_PATH, "a", encoding="utf-8")
    process_creation_flags = 0
    if sys.platform == "win32":
        # The server must outlive the launcher and must not open a console window.
        process_creation_flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    subprocess.Popen(
        [
            sys.executable, "-m", "uvicorn", "backend.main:app",
            "--host", SERVER_HOST, "--port", str(SERVER_PORT),
        ],
        cwd=PROJECT_ROOT_DIRECTORY,
        stdin=subprocess.DEVNULL,
        stdout=server_log_file,
        stderr=subprocess.STDOUT,
        creationflags=process_creation_flags,
    )


def wait_for_server() -> bool:
    deadline = time.monotonic() + SERVER_START_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if is_server_responding():
            return True
        time.sleep(SERVER_POLL_INTERVAL_SECONDS)
    return False


# Preferred browser first; the reader falls back to Edge and then to the system default.
BROWSER_CANDIDATES = (
    ("chrome", ("Google", "Chrome", "Application", "chrome.exe")),
    ("msedge", ("Microsoft", "Edge", "Application", "msedge.exe")),
)

# True opens a separate window without tabs and address bar (--app); False opens a normal tab.
OPEN_AS_APP_WINDOW = False


def locate_browser_executable() -> str | None:
    for executable_name, relative_path_parts in BROWSER_CANDIDATES:
        executable_on_path = shutil.which(executable_name)
        if executable_on_path:
            return executable_on_path
        for program_files_variable in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
            program_files_directory = os.environ.get(program_files_variable)
            if not program_files_directory:
                continue
            candidate_executable_path = Path(program_files_directory).joinpath(*relative_path_parts)
            if candidate_executable_path.is_file():
                return str(candidate_executable_path)
    return None


def open_reader_window(pdf_file_path: str | None) -> None:
    reader_url = f"{SERVER_BASE_URL}/"
    if pdf_file_path:
        reader_url += "?file=" + urllib.parse.quote(str(Path(pdf_file_path).resolve()))
    browser_executable = locate_browser_executable()
    if browser_executable is None:
        webbrowser.open(reader_url)
        return
    browser_arguments = [f"--app={reader_url}"] if OPEN_AS_APP_WINDOW else [reader_url]
    subprocess.Popen([browser_executable, *browser_arguments])


def wait_for_server_to_stop() -> None:
    deadline = time.monotonic() + SERVER_START_TIMEOUT_SECONDS
    while time.monotonic() < deadline and is_server_responding():
        time.sleep(SERVER_POLL_INTERVAL_SECONDS)
    # The listening socket can linger for a moment after the old process stops answering.
    time.sleep(1.0)


def restart_server() -> None:
    wait_for_server_to_stop()
    start_server_in_background()
    wait_for_server()


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "--restart-server":
        restart_server()
        return
    pdf_file_path = sys.argv[1] if len(sys.argv) > 1 else None
    if not is_server_responding():
        start_server_in_background()
        if not wait_for_server():
            show_error_message(f"Сервер не запустился за {SERVER_START_TIMEOUT_SECONDS} с.\nПодробности: {SERVER_LOG_FILE_PATH}")
            return
    open_reader_window(pdf_file_path)


if __name__ == "__main__":
    main()
