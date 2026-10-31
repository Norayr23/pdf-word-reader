"""Central configuration shared by the server and the launcher."""
from pathlib import Path

PROJECT_ROOT_DIRECTORY = Path(__file__).resolve().parent.parent
FRONTEND_DIRECTORY = PROJECT_ROOT_DIRECTORY / "frontend"
DATA_DIRECTORY = PROJECT_ROOT_DIRECTORY / "data"
DATABASE_FILE_PATH = DATA_DIRECTORY / "reader.sqlite3"
SERVER_LOG_FILE_PATH = DATA_DIRECTORY / "server.log"

# Claude CLI is started from an empty working directory so that it does not pick up
# CLAUDE.md files or project settings from wherever the server happens to run.
CLAUDE_ISOLATED_WORKING_DIRECTORY = DATA_DIRECTORY / "claude_workdir"

SERVER_HOST = "127.0.0.1"
SERVER_PORT = 8765

CLAUDE_MODEL_ALIAS = "haiku"
CLAUDE_CALL_TIMEOUT_SECONDS = 120

# A word analysis runs three part calls at once; the cap still prevents a burst of processes
# (and of subscription usage) when the user clicks through many words quickly.
MAXIMUM_PARALLEL_CLAUDE_CALLS = 4

# By default Claude Code sends its large agent system prompt, tool definitions and MCP
# servers with every request. None of that is needed for a single JSON answer, and it
# both slows the call down and consumes subscription limits. If an installed CLI version
# does not know one of these flags, the client falls back to the plain call automatically.
CLAUDE_SYSTEM_PROMPT = (
    "You are a precise English-Russian vocabulary tutor. "
    "You always answer with a single valid JSON object and nothing else."
)
CLAUDE_SPEED_ARGUMENTS = [
    "--system-prompt", CLAUDE_SYSTEM_PROMPT,
    "--tools", "",
    "--strict-mcp-config",
]

EXTERNAL_HTTP_TIMEOUT_SECONDS = 8
SOURCE_LANGUAGE_CODE = "en"
TARGET_LANGUAGE_CODE = "ru"
