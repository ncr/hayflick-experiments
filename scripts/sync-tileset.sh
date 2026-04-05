#!/usr/bin/env bash
# Sync tileset artifacts from blockstudio into this project's assets.
# Usage: scripts/sync-tileset.sh [tileset_id]
# Default: modern_desert_monolith

set -euo pipefail

TILESET="${1:-modern_desert_monolith}"
BLOCKSTUDIO_ROOT="${BLOCKSTUDIO_ROOT:-$(cd "$(dirname "$0")/../../blockstudio" && pwd)}"
SRC="$BLOCKSTUDIO_ROOT/tilesets/$TILESET"
DEST="$(cd "$(dirname "$0")/.." && pwd)/assets/tilesets/$TILESET"

if [ ! -d "$SRC" ]; then
  echo "ERROR: blockstudio tileset not found at $SRC" >&2
  echo "Set BLOCKSTUDIO_ROOT env var if blockstudio is not at ../blockstudio" >&2
  exit 1
fi

echo "Syncing tileset: $TILESET"
echo "  from: $SRC"
echo "  to:   $DEST"

# Clean destination
rm -rf "$DEST"
mkdir -p "$DEST"

# Copy artifacts: tiles (GLBs + manifests), kit manifest, tileset.game.json
if [ -d "$SRC/artifacts/tiles" ]; then
  cp -R "$SRC/artifacts/tiles" "$DEST/tiles"
  echo "  tiles: $(ls "$DEST/tiles" | wc -l | tr -d ' ') copied"
fi

if [ -d "$SRC/artifacts/kit" ]; then
  cp -R "$SRC/artifacts/kit" "$DEST/kit"
  echo "  kit manifest: copied"
fi

if [ -f "$SRC/artifacts/tileset.game.json" ]; then
  cp "$SRC/artifacts/tileset.game.json" "$DEST/tileset.game.json"
  echo "  tileset.game.json: copied"
fi

# Copy textures from project dir
if [ -d "$SRC/project/textures" ]; then
  mkdir -p "$DEST/textures"
  cp "$SRC/project/textures/"*.png "$DEST/textures/" 2>/dev/null || true
  echo "  textures: $(ls "$DEST/textures/"*.png 2>/dev/null | wc -l | tr -d ' ') copied"
fi

echo "Done."
