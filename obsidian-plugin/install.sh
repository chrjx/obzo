#!/usr/bin/env bash
# Copy the built plugin into your Obsidian vault's plugins folder.
# Usage: bash install.sh [/path/to/vault]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VAULT="${1:-/Users/chrix/Documents/Obsidian}"
DEST="$VAULT/.obsidian/plugins/obzo-complete"

if [ ! -f "$HERE/main.js" ]; then
  echo "main.js not found — run 'npm run build' first." >&2
  exit 1
fi

mkdir -p "$DEST"
# manifest.json is the canonical one at the repo root (used for publishing too).
cp "$HERE/../manifest.json" "$HERE/main.js" "$HERE/styles.css" "$DEST/"
echo "Installed to: $DEST"
echo "Now enable 'Obzo' in Obsidian: Settings → Community plugins."
