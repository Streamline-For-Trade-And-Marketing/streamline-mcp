#!/usr/bin/env bash
#
# Build + run the in-dashboard Gemini chat service (POST /chat) that powers
# the dashboard's "Streamline API" page. Reuses the MCP tool registry
# (buildTools) and drives it with Gemini function-calling.
#
# Config is read from ./.env.chat (gitignored) if present, otherwise from
# the environment. Override any value inline, e.g.:
#   GEMINI_MODEL=gemini-2.5-flash-lite ./start-chat.sh
#
set -euo pipefail
cd "$(dirname "$0")"

# Load local config/secrets if present.
if [ -f .env.chat ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.chat
  set +a
fi

: "${GEMINI_API_KEY:?Set GEMINI_API_KEY (in .env.chat or the environment)}"
export GEMINI_MODELS="${GEMINI_MODELS:-gemini-2.5-flash-lite,gemini-2.0-flash-lite,gemini-2.0-flash,gemini-2.5-flash,gemma-4-31b-it,gemma-4-26b-a4b-it}"
export STREAMLINE_BASE="${STREAMLINE_BASE:-http://localhost:8010/vendor/v1}"
export CHAT_PORT="${CHAT_PORT:-8011}"
export CHAT_ALLOWED_ORIGINS="${CHAT_ALLOWED_ORIGINS:-http://localhost:3010,http://127.0.0.1:3010}"

echo "[start-chat] building…"
npm run build

echo "[start-chat] starting chat service on port ${CHAT_PORT} (models=${GEMINI_MODELS}, base=${STREAMLINE_BASE})"
exec node dist/chat-server.js
