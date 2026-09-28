#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load APIGEE_API_KEY (and optional overrides) from WebUI/.env if present.
# Created by ../setup-apigee-resources.sh; never commit this file.
if [ -f "$DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$DIR/.env"
  set +a
fi

# Choose available port (default 8081 if 8080 is in use)
if [ -z "$PORT" ]; then
  if lsof -i :8080 >/dev/null 2>&1; then
    PORT=8081
  else
    PORT=8080
  fi
fi

# Local-only by default. Set HOST=0.0.0.0 explicitly to expose on the network.
HOST="${HOST:-127.0.0.1}"

echo "=================================================================="
echo "🛡️ Starting Apigee + Sensitive Data Protection Web UI"
echo "URL: http://localhost:${PORT}  (bound to ${HOST})"
echo "=================================================================="
HOST="$HOST" PORT="$PORT" exec python3 "$DIR/app.py"
