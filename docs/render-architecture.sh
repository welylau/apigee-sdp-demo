#!/bin/bash
# Renders docs/architecture-diagram.html -> docs/architecture.png (1600x900 @2x = 3200x1800), the source of truth,
# and copies it to WebUI/static/assets/architecture.png (served to the Web UI's architecture modal).
# The project id is swapped for a placeholder in a temp copy first, so the PNG never holds real values.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
SRC="$DIR/docs/architecture-diagram.html"
OUT="$DIR/docs/architecture.png"
WEB="$DIR/WebUI/static/assets/architecture.png"

PROJECT_ID="${PROJECT_ID:-$(grep -o 'projects/[a-z][a-z0-9-]*/' "$SRC" | head -1 | cut -d/ -f2 || true)}"
# Same directory as the source so the relative icon paths (../WebUI/static/assets/*.svg) resolve.
TMP="$DIR/docs/.architecture-render.tmp.html"
trap 'rm -f "$TMP"' EXIT
if [ -n "$PROJECT_ID" ]; then
  sed "s/${PROJECT_ID}/YOUR_GCP_PROJECT_ID/g" "$SRC" > "$TMP"
else
  cp "$SRC" "$TMP"
fi

# --virtual-time-budget lets the web fonts load before the screenshot.
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files \
  --force-device-scale-factor=2 --window-size=1600,900 --virtual-time-budget=3000 \
  --screenshot="$OUT" "file://$TMP"
cp "$OUT" "$WEB"
echo "Wrote $OUT and $WEB"
