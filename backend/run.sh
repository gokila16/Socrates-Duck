#!/bin/sh
# Loads .env, then starts the backend, or runs the given command with the same environment.
set -eu
cd "$(dirname "$0")"

if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

if [ "$#" -eq 0 ]; then
  exec .venv/bin/uvicorn api.app:create_app --factory --host 127.0.0.1 --port "${SOCRATES_DUCK_PORT:-8000}"
fi

exec "$@"
