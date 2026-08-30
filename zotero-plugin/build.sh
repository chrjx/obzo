#!/usr/bin/env bash
# Package the Obzo Bridge Zotero plugin into an installable .xpi
# (an .xpi is just a zip of manifest.json + bootstrap.js at the archive root).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$HERE/../dist"
XPI="$DIST/obzo-bridge.xpi"

mkdir -p "$DIST"
rm -f "$XPI"

cd "$HERE"
zip -q -X "$XPI" manifest.json bootstrap.js

echo "Built: $XPI"
