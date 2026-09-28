#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Idempotent setup of Apigee consumer resources for gemini-sdp-proxy:
#   - API product  : sdp-demo-product (gemini-sdp-proxy, default-dev)
#   - Developer    : sdp-demo@example.com
#   - App          : sdp-demo-webui       (sdp_bypass_allowed=true, sdp_debug_allowed=true)
#   - App          : sdp-demo-restricted  (no attributes -> SDP always enforced, no X-ray)
# Writes the WebUI key to WebUI/.env (gitignored) and prints both keys.
# Uses Application Default Credentials (gcloud auth application-default login).
# ==============================================================================

ORG="${APIGEE_ORG:-YOUR_GCP_PROJECT_ID}"
ENV="${APIGEE_ENV:-default-dev}"
PROXY_NAME="gemini-sdp-proxy"
PRODUCT="sdp-demo-product"
DEV_EMAIL="sdp-demo@example.com"
APP_WEBUI="sdp-demo-webui"
APP_RESTRICTED="sdp-demo-restricted"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTH=(--default-token -o "$ORG" --disable-check)

exists() { "$@" "${AUTH[@]}" >/dev/null 2>&1; }

echo "🔧 Apigee org: $ORG / env: $ENV"

if exists apigeecli products get -n "$PRODUCT"; then
  echo "✔ API product '$PRODUCT' exists"
else
  echo "➕ Creating API product '$PRODUCT'"
  apigeecli products create -n "$PRODUCT" -m "SDP Demo Product" \
    -d "Access to gemini-sdp-proxy (Sensitive Data Protection AI gateway demo)" \
    -p "$PROXY_NAME" -e "$ENV" -f auto --attrs access=private "${AUTH[@]}" >/dev/null
fi

if exists apigeecli developers get -n "$DEV_EMAIL"; then
  echo "✔ Developer '$DEV_EMAIL' exists"
else
  echo "➕ Creating developer '$DEV_EMAIL'"
  apigeecli developers create -n "$DEV_EMAIL" -f SDP -s Demo -u sdp-demo "${AUTH[@]}" >/dev/null
fi

# Prints the consumer key of a developer app, or nothing if the app does not exist.
# (apigeecli "apps get" exits 0 even when the app is missing, so query via the developer.)
app_key() {
  apigeecli developers getapps -n "$DEV_EMAIL" -x "${AUTH[@]}" 2>/dev/null | APP="$1" python3 -c '
import json, os, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
apps = data.get("app", []) if isinstance(data, dict) else data
for a in apps or []:
    if a.get("name") == os.environ["APP"] and a.get("credentials"):
        print(a["credentials"][0]["consumerKey"])
        break
'
}

create_app() {
  local name="$1"; shift
  if [ -n "$(app_key "$name")" ]; then
    echo "✔ App '$name' exists"
  else
    echo "➕ Creating app '$name'"
    apigeecli apps create -n "$name" -e "$DEV_EMAIL" -p "$PRODUCT" "$@" "${AUTH[@]}" >/dev/null
  fi
}
create_app "$APP_WEBUI" --attrs sdp_bypass_allowed=true
create_app "$APP_RESTRICTED"

# Upserts one custom attribute on a developer app (works for apps that already exist).
# The per-attribute endpoint cannot create new attributes, so merge into the full list.
ensure_attr() {
  local app="$1" name="$2" value="$3" token base body code
  token="${TOKEN:-$(gcloud auth application-default print-access-token)}"
  base="https://apigee.googleapis.com/v1/organizations/${ORG}/developers/${DEV_EMAIL}/apps/${app}"
  body=$(curl -sS "$base" -H "Authorization: Bearer ${token}" | NAME="$name" VALUE="$value" python3 -c '
import json, os, sys
attrs = [a for a in json.load(sys.stdin).get("attributes", []) if a.get("name") != os.environ["NAME"]]
attrs.append({"name": os.environ["NAME"], "value": os.environ["VALUE"]})
print(json.dumps({"attribute": attrs}))')
  code=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "${base}/attributes" \
    -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" --data "$body")
  if [ "$code" = "200" ]; then
    echo "✔ ${app}: ${name}=${value}"
  else
    echo "❌ Could not set ${name} on ${app} (HTTP ${code})" >&2
    exit 1
  fi
}
ensure_attr "$APP_WEBUI" sdp_bypass_allowed true   # may switch SDP off (demo compare mode)
ensure_attr "$APP_WEBUI" sdp_debug_allowed true    # may request the sanitized X-ray (x-sdp-debug)

WEBUI_KEY="$(app_key "$APP_WEBUI")"
RESTRICTED_KEY="$(app_key "$APP_RESTRICTED")"
if [ -z "$WEBUI_KEY" ] || [ -z "$RESTRICTED_KEY" ]; then
  echo "❌ Could not read app credentials" >&2
  exit 1
fi

ENV_FILE="$DIR/WebUI/.env"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
grep -v '^APIGEE_API_KEY=' "$ENV_FILE" > "$ENV_FILE.tmp" || true
echo "APIGEE_API_KEY=$WEBUI_KEY" >> "$ENV_FILE.tmp"
mv "$ENV_FILE.tmp" "$ENV_FILE"
chmod 600 "$ENV_FILE"

echo ""
echo "✅ Done. WebUI key written to WebUI/.env"
echo "   export APIGEE_API_KEY=$WEBUI_KEY              # $APP_WEBUI (bypass allowed)"
echo "   export APIGEE_RESTRICTED_API_KEY=$RESTRICTED_KEY   # $APP_RESTRICTED (bypass denied)"
