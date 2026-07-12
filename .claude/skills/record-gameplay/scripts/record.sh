#!/usr/bin/env bash
# record.sh — render a gameplay walkthrough video from the rt-viewer
# DEMO harness (deterministic per-tick capture) and encode it to an mp4.
#
#   record.sh <trace.txt> [out.mp4]   # render + encode the trace
#
# DEMO plays the gym-format <trace.txt> ONE sim tick per frame (the wall
# clock never ticks the sim, so it is byte-reproducible), dumping a PNG per
# tick; then ffmpeg encodes the PNGs to an iPhone-friendly H.264 mp4.
#
# Env overrides (also: any viewer env passes straight through):
#   WINDOW=1280x800   capture resolution
#   FPS=60            playback frame rate (sim runs at 60 ticks/s -> 60 = real speed)
#   TICKS=<n>         frame/tick count (default: last trace stamp + 1)
#   LOOK, LIGHTS, LIGHT_ANIM, STYLE, ...  forwarded as-is
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && git rev-parse --show-toplevel 2>/dev/null)" || ROOT=""
[ -n "$ROOT" ] || ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$ROOT"
VIEWER=./target/release/viewer
MANIFEST=Cargo.toml

trace="${1:?usage: record.sh <trace.txt> [out.mp4]}"
out="${2:-${TMPDIR:-/tmp}/gym-gameplay.mp4}"
window="${WINDOW:-1280x800}"
fps="${FPS:-60}"
[ -f "$trace" ] || { echo "trace not found: $trace" >&2; exit 1; }

cargo build --release --manifest-path "$MANIFEST" >/dev/null
frames="$(mktemp -d -t recframes.XXXX)"
trap 'rm -rf "$frames"' EXIT

# `env` carries the optional DEMO_TICKS: a ${TICKS:+VAR=val} expansion is NOT
# recognised as an assignment by the shell (expansions happen after assignment
# parsing), so without `env` it would be executed as a command and fail.
# shellcheck disable=SC2086  # TICKS is intentionally word-split into an env assignment or nothing
WINDOW="$window" LIGHT_ANIM="${LIGHT_ANIM:-0}"   DEMO="$trace" DEMO_DIR="$frames"   env ${TICKS:+DEMO_TICKS=$TICKS} "$VIEWER" 2>&1 | tail -1

# even dims for yuv420p; nearest-neighbour keeps the pixel-art crisp if scaled
ffmpeg -y -framerate "$fps" -i "$frames/d_%05d.png"   -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=neighbor,format=yuv420p"   -c:v libx264 -crf 20 -movflags +faststart "$out" 2>/dev/null

echo "recorded $out ($(wc -c < "$out" | tr -d ' ') bytes, ${fps}fps)"
