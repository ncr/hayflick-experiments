#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Kill existing processes
fuser -k 5173/tcp 2>/dev/null || true
sudo fuser -k 443/tcp 2>/dev/null || true
sleep 0.3

# Start caddy (needs port 443, so sudo)
sudo caddy run --config "$ROOT/Caddyfile" &

# Start vite
pnpm --filter @apps/hub dev
