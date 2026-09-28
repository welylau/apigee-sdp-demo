#!/bin/bash
# Renders docs/architecture-diagram.html -> WebUI/static/assets/architecture-diagram.png (2x, 3200x1920).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
OUT="$DIR/WebUI/static/assets/architecture-diagram.png"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files \
  --force-device-scale-factor=2 --window-size=1600,960 \
  --screenshot="$OUT" "file://$DIR/docs/architecture-diagram.html"
echo "Wrote $OUT"
