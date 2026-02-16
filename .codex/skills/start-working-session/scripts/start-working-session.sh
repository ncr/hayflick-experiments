#!/usr/bin/env bash

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
PID_FILE="/tmp/hayflick-dev-server.pid"
LOG_FILE="/tmp/hayflick-dev-server.log"
DEV_COMMAND=(pnpm --filter @apps/hub dev --host 127.0.0.1 --port 4173 --strictPort)
DRY_RUN=0

usage() {
  cat <<EOF
Usage: $SCRIPT_NAME [--dry-run]

Start a working session by pulling latest changes and launching the local dev server in background.
EOF
}

run_command() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '+'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
  shift
fi

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

if [ "$#" -ne 0 ]; then
  usage
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

echo "Fetching upstream refs..."
run_command git fetch --all --prune

echo "Attempting to fast-forward current branch..."
if [ "$DRY_RUN" -eq 1 ]; then
  run_command git pull --ff-only --autostash
else
  if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
    if git pull --ff-only --autostash; then
      echo "Current branch is up to date."
    else
      echo "Fast-forward pull did not apply cleanly."
      echo "Upstream changes are fetched locally; continuing."
    fi
  else
    echo "No upstream tracking branch configured; skipping pull."
  fi
fi

if [ -f "$PID_FILE" ]; then
  EXISTING_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$EXISTING_PID" ] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    echo "Dev server already running with PID $EXISTING_PID."
    echo "Log file: $LOG_FILE"
    exit 0
  fi
  run_command rm -f "$PID_FILE"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  printf '+ CI=1 nohup'
  printf ' %q' "${DEV_COMMAND[@]}"
  printf ' > %q 2>&1 < /dev/null &\n' "$LOG_FILE"
  echo "+ write pid to $PID_FILE"
  exit 0
fi

echo "Starting local dev server in background..."
CI=1 nohup "${DEV_COMMAND[@]}" >"$LOG_FILE" 2>&1 < /dev/null &
SERVER_PID=$!
echo "$SERVER_PID" >"$PID_FILE"

sleep 2
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "Dev server failed to start. Check log: $LOG_FILE"
  exit 1
fi

echo "Dev server started successfully."
echo "PID: $SERVER_PID"
echo "Log file: $LOG_FILE"
echo "Stop with: kill \"\$(cat $PID_FILE)\""
