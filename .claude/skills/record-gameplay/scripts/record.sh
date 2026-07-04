#!/usr/bin/env bash
# record.sh — render a gameplay walkthrough video from the rt-viewer
# DEMO harness (deterministic per-tick capture) and encode it to an mp4.
#
#   record.sh --dump <scene>                 # print room rects + door gaps (to author a trace)
#   record.sh <scene> <trace.txt> [out.mp4]  # render + encode the trace
#
# DEMO plays the CMDS-format <trace.txt> ONE sim tick per frame (the wall clock
# never ticks the sim, so it is byte-reproducible), dumping a PNG per tick; then
# ffmpeg encodes the PNGs to an iPhone-friendly H.264 mp4.
#
# Env overrides (also: any viewer env passes straight through):
#   WINDOW=1280x800   capture resolution
#   FPS=60            playback frame rate (sim runs at 60 ticks/s → 60 = real speed)
#   TICKS=<n>         frame/tick count (default: last trace stamp + 1)
#   ROI_XRAY, CAVE_SEED, DOORS, LIGHTS, LIGHT_ANIM, STYLE, ...  forwarded as-is
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && git rev-parse --show-toplevel 2>/dev/null)" || ROOT=""
[ -n "$ROOT" ] || ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$ROOT"
VIEWER=./target/release/viewer
MANIFEST=Cargo.toml

build() { cargo build --release --manifest-path "$MANIFEST" >/dev/null; }

if [ "${1:-}" = "--dump" ]; then
  scene="${2:?usage: record.sh --dump <scene>}"
  build
  shot="$(mktemp -t recdump.XXXX.png)"
  trap 'rm -f "$shot"' EXIT
  # DOORS=1 keeps the DoorSpec entries so DUMP_ROOMS can print door-gap rects;
  # the gameplay render itself usually runs WITHOUT DOORS (open gaps to walk).
  DUMP_ROOMS=1 DOORS=1 SCENE="$scene" SHOT="$shot" SHOT_DELAY=0 "$VIEWER" 2>/dev/null \
    | grep -E "^(START|ROOM|DOOR) " || { echo "no layout dumped for SCENE=$scene (not a floor-plan scene?)" >&2; exit 1; }
  exit 0
fi

scene="${1:?usage: record.sh <scene> <trace.txt> [out.mp4]}"
trace="${2:?usage: record.sh <scene> <trace.txt> [out.mp4]}"
out="${3:-${TMPDIR:-/tmp}/${scene}-gameplay.mp4}"
# the arena pit needs the wide frame: 1600x1000 at its PIXEL=2 default shows
# the whole 20x20 wu floor; other scenes keep the classic 1280x800
case "$scene" in
  arena|drain|squeeze) window="${WINDOW:-1600x1000}" ;;
  *)     window="${WINDOW:-1280x800}" ;;
esac
fps="${FPS:-60}"
[ -f "$trace" ] || { echo "trace not found: $trace" >&2; exit 1; }

build
frames="$(mktemp -d -t recframes.XXXX)"
trap 'rm -rf "$frames"' EXIT

# `env` carries the optional DEMO_TICKS: a ${TICKS:+VAR=val} expansion is NOT
# recognised as an assignment by the shell (expansions happen after assignment
# parsing), so without `env` it would be executed as a command and fail.
# shellcheck disable=SC2086  # TICKS is intentionally word-split into an env assignment or nothing
SCENE="$scene" WINDOW="$window" LIGHT_ANIM="${LIGHT_ANIM:-0}" \
  DEMO="$trace" DEMO_DIR="$frames" \
  env ${TICKS:+DEMO_TICKS=$TICKS} "$VIEWER" 2>&1 | tail -1

# even dims for yuv420p; nearest-neighbour keeps the pixel-art crisp if scaled
ffmpeg -y -framerate "$fps" -i "$frames/d_%05d.png" \
  -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=neighbor,format=yuv420p" \
  -c:v libx264 -crf 20 -movflags +faststart "$out" 2>/dev/null

echo "recorded $out ($(wc -c < "$out" | tr -d ' ') bytes, ${fps}fps)"
