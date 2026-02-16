---
name: start-working-session
description: Pull the latest changes for the current branch and launch the Hayflick local dev server in the background. Use when the user asks to start or begin a working session, get up to date before coding, or run the local server detached while continuing terminal work.
---

# Start Working Session

Use this skill to sync upstream changes, then launch the local server as a persistent Codex background session.

## Workflow

1. Sync upstream changes locally:
   `git fetch --all --prune`
2. Attempt branch fast-forward update without blocking development flow:
   `git pull --ff-only --autostash` (continue if it does not apply cleanly)
3. Launch local server as a Codex background session (TTY session), not with shell `nohup`:
   `pnpm --filter @apps/hub dev --host 127.0.0.1 --port 4173 --strictPort`
4. Report completion details:
   - fetch/pull outcome,
   - background `session_id`,
   - local URL (`http://127.0.0.1:4173`),
   - how to stop (send `Ctrl+C` to that session).

## Script behavior

The helper script exists for shell-only usage and performs these steps in order:

1. Resolve and `cd` to repo root via `git rev-parse --show-toplevel`.
2. Run `git fetch --all --prune` to ensure all upstream changes are available locally.
3. Attempt `git pull --ff-only --autostash`; if it cannot apply cleanly, continue after reporting that fetch succeeded.
4. Skip launch if PID file points to a running server.
5. Start `pnpm --filter @apps/hub dev --host 127.0.0.1 --port 4173 --strictPort` detached with `CI=1 nohup` for non-Codex shell usage.
6. Write runtime files:
   - PID: `/tmp/hayflick-dev-server.pid`
   - Log: `/tmp/hayflick-dev-server.log`

## Verification and debugging

- Use `bash .codex/skills/start-working-session/scripts/start-working-session.sh --dry-run` to preview actions without side effects.
- If startup fails, inspect logs with `tail -n 120 /tmp/hayflick-dev-server.log`.
- In Codex background-session mode, verify with `curl -I http://127.0.0.1:4173`.
