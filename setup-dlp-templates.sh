#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Idempotently creates (or updates) the v2 Sensitive Data Protection templates
# used by gemini-sdp-proxy:
#   inspectTemplates/inspect-sensitive-v2       <- dlp/inspect-sensitive-v2.json
#   deidentifyTemplates/deidentify-sensitive-v2 <- dlp/deidentify-sensitive-v2.json
# The original inspect-sensitve / deidentify-sensitve templates are left untouched,
# so rolling back is a one-line change in resources/properties/sdp.properties.
# Uses Application Default Credentials (override with TOKEN=...).
# ==============================================================================

PROJECT="${DLP_PROJECT:-YOUR_GCP_PROJECT_ID}"
LOCATION="${DLP_LOCATION:-asia-southeast1}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOKEN="${TOKEN:-$(gcloud auth application-default print-access-token)}"
BASE="https://dlp.googleapis.com/v2/projects/${PROJECT}/locations/${LOCATION}"

api() {
  # api METHOD URL [BODY_FILE] -> prints the HTTP status; response body goes to .dlp_resp.json
  local method="$1" url="$2" body="${3:-}"
  local args=(-sS -o "$DIR/.dlp_resp.json" -w "%{http_code}" -X "$method" "$url"
    -H "Authorization: Bearer ${TOKEN}" -H "x-goog-user-project: ${PROJECT}"
    -H "Content-Type: application/json")
  [ -n "$body" ] && args+=(--data-binary "@${body}")
  curl "${args[@]}"
}

upsert() {
  local kind="$1" collection="$2" id="$3" file="$4" mask="$5"
  local wrapped="$DIR/.dlp_body.json"
  local code
  code=$(api GET "${BASE}/${collection}/${id}")
  if [ "$code" = "200" ]; then
    python3 -c 'import json,sys; t=json.load(open(sys.argv[1])); print(json.dumps({sys.argv[2]: t, "updateMask": sys.argv[3]}))' \
      "$file" "$kind" "$mask" > "$wrapped"
    code=$(api PATCH "${BASE}/${collection}/${id}" "$wrapped")
    echo "  ↻ updated ${collection}/${id} (HTTP $code)"
  else
    python3 -c 'import json,sys; t=json.load(open(sys.argv[1])); print(json.dumps({sys.argv[2]: t, "templateId": sys.argv[3]}))' \
      "$file" "$kind" "$id" > "$wrapped"
    code=$(api POST "${BASE}/${collection}" "$wrapped")
    echo "  ➕ created ${collection}/${id} (HTTP $code)"
  fi
  rm -f "$wrapped"
  if [ "${code:0:1}" != "2" ]; then
    cat "$DIR/.dlp_resp.json" >&2; rm -f "$DIR/.dlp_resp.json"; exit 1
  fi
  rm -f "$DIR/.dlp_resp.json"
}

echo "🔧 SDP templates in projects/${PROJECT}/locations/${LOCATION}"
upsert inspectTemplate inspectTemplates inspect-sensitive-v2 \
  "$DIR/dlp/inspect-sensitive-v2.json" "displayName,description,inspectConfig"
upsert deidentifyTemplate deidentifyTemplates deidentify-sensitive-v2 \
  "$DIR/dlp/deidentify-sensitive-v2.json" "displayName,description,deidentifyConfig"
echo "✅ Done"
