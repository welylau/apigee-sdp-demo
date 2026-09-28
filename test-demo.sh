#!/usr/bin/env bash
set -uo pipefail

# ==============================================================================
# Regression suite for gemini-sdp-proxy (Apigee + SDP + Cloud Logging)
# Gemini 3.5 Flash-Lite on the Vertex AI global endpoint.
#
# Keys: APIGEE_API_KEY (bypass-allowed app, loaded from WebUI/.env) and
#       APIGEE_RESTRICTED_API_KEY (bypass-denied app). Both are printed by
#       ./setup-apigee-resources.sh; the restricted key is fetched automatically
#       via apigeecli if not set.
# ==============================================================================

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$DIR/WebUI/.env" ] && { set -a; . "$DIR/WebUI/.env"; set +a; }

APIGEE_HOST="${APIGEE_HOST:-YOUR_APIGEE_IP.nip.io}"
GATEWAY_URL="https://${APIGEE_HOST}/gemini-sdp-proxy"
ORG="${APIGEE_ORG:-YOUR_GCP_PROJECT_ID}"
KEY="${APIGEE_API_KEY:?APIGEE_API_KEY not set - run ./setup-apigee-resources.sh}"
RKEY="${APIGEE_RESTRICTED_API_KEY:-}"
if [ -z "$RKEY" ]; then
  RKEY=$(apigeecli developers getapps -n sdp-demo@example.com -x -o "$ORG" --default-token --disable-check 2>/dev/null |
    python3 -c 'import json,sys; d=json.load(sys.stdin); print(next(a["credentials"][0]["consumerKey"] for a in d.get("app",[]) if a.get("name")=="sdp-demo-restricted"))' 2>/dev/null || true)
fi

PASS=0; FAIL=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# call <key|-> <json body> [extra curl args...]  -> sets STATUS, HEADERS, BODY
call() {
  local key="$1" body="$2"; shift 2
  local tmp; tmp=$(mktemp -d "$DIR/.test.XXXXXX")
  local auth=(-H "x-no-key: 1"); [ "$key" != "-" ] && auth=(-H "x-api-key: $key")
  STATUS=$(curl -s -k -o "$tmp/body" -D "$tmp/headers" -w '%{http_code}' -X POST "$GATEWAY_URL" \
    -H "Content-Type: application/json" "${auth[@]}" "$@" -d "$body")
  HEADERS=$(tr -d '\r' < "$tmp/headers"); BODY=$(cat "$tmp/body"); rm -rf "$tmp"
}
hdr()  { echo "$HEADERS" | grep -i "^$1:" | head -1 | cut -d' ' -f2- ; }
text() { echo "$BODY" | jq -r '[.candidates[]?.content.parts[]?.text // empty] | join("\n")'; }

echo "======================================================================"
echo "🎯 gemini-sdp-proxy regression suite → $GATEWAY_URL"
echo "======================================================================"

echo "🧪 [1] Missing API key is rejected"
call - '{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}'
check "HTTP 401 (got $STATUS)" '[ "$STATUS" = "401" ]'
check "sanitized error body" '[ "$(echo "$BODY" | jq -r .error.status)" = "UNAUTHENTICATED" ]'

echo "🧪 [2] Clean prompt"
call "$KEY" '{"contents":[{"role":"user","parts":[{"text":"Explain quantum computing in one short sentence."}]}]}'
check "HTTP 200 (got $STATUS)" '[ "$STATUS" = "200" ]'
check "inbound clean" '[ "$(hdr x-sdp-inbound-sensitive-data-detected)" = "false" ]'
check "X-Request-Id present" '[ -n "$(hdr x-request-id)" ]'
echo "     ↳ $(text | head -c 160)"

echo "🧪 [3] Single-turn PII (NRIC, passport, card) is de-identified"
call "$KEY" '{"contents":[{"role":"user","parts":[{"text":"Verify customer profile: NRIC S9876543C, Passport K1234567Z, Card 4532015112830366. Summarize the details."}]}]}'
check "HTTP 200 (got $STATUS)" '[ "$STATUS" = "200" ]'
check "inbound detected ($(hdr x-sdp-inbound-finding-types))" '[ "$(hdr x-sdp-inbound-sensitive-data-detected)" = "true" ]'
check "no raw NRIC/card in response" '! text | grep -Eq "S9876543C|4532015112830366"'

echo "🧪 [4] Multi-turn + systemInstruction PII (previously leaked raw to Gemini)"
# Outbound SDP is switched off (allowed for this app) so the model's echo shows exactly what it received.
call "$KEY" '{"systemInstruction":{"parts":[{"text":"You are a support agent for the customer with NRIC S7654321F."}]},"contents":[{"role":"user","parts":[{"text":"My NRIC is S1234567D."}]},{"role":"model","parts":[{"text":"Thanks, noted."}]},{"role":"user","parts":[{"text":"Repeat back, verbatim, every identifier you have seen in this conversation, including the system instruction."}]}]}' -H "sdp-outbound: false"
check "HTTP 200 (got $STATUS)" '[ "$STATUS" = "200" ]'
check "4 parts inspected (got $(hdr x-sdp-inbound-parts-inspected))" '[ "$(hdr x-sdp-inbound-parts-inspected)" = "4" ]'
check "2 inbound findings (got $(hdr x-sdp-inbound-findings-count))" '[ "$(hdr x-sdp-inbound-findings-count)" = "2" ]'
check "model never saw raw NRICs" '! text | grep -Eq "S1234567D|S7654321F"'
echo "     ↳ $(text | tr '\n' ' ' | head -c 200)"

echo "🧪 [5] Outbound: PII in the model output is masked before reaching the client"
# Inbound SDP is switched off so the model receives (and echoes) raw PII; outbound SDP must catch it.
call "$KEY" '{"contents":[{"role":"user","parts":[{"text":"Repeat exactly, with no other text: Your registered Singapore NRIC is S1234567D and card on file is 4532015112830366."}]}]}' -H "sdp-inbound: false"
check "HTTP 200 (got $STATUS)" '[ "$STATUS" = "200" ]'
check "outbound detected ($(hdr x-sdp-outbound-finding-types))" '[ "$(hdr x-sdp-outbound-sensitive-data-detected)" = "true" ]'
check "no raw NRIC/card returned" '! text | grep -Eq "S1234567D|4532015112830366"'
echo "     ↳ $(text | tr '\n' ' ' | head -c 160)"

echo "🧪 [6] SDP bypass is denied for apps without sdp_bypass_allowed"
if [ -n "$RKEY" ]; then
  call "$RKEY" '{"contents":[{"role":"user","parts":[{"text":"NRIC S1234567D"}]}]}' -H "sdp-inbound: false"
  check "HTTP 403 (got $STATUS)" '[ "$STATUS" = "403" ]'
  check "PERMISSION_DENIED" '[ "$(echo "$BODY" | jq -r .error.status)" = "PERMISSION_DENIED" ]'
  call "$RKEY" '{"contents":[{"role":"user","parts":[{"text":"Say OK"}]}]}'
  check "restricted app works normally with SDP on (got $STATUS)" '[ "$STATUS" = "200" ]'
else
  bad "APIGEE_RESTRICTED_API_KEY unavailable - skipped"
fi

echo "🧪 [7] SDP bypass is honoured for the allowed app"
call "$KEY" '{"contents":[{"role":"user","parts":[{"text":"Say OK"}]}]}' -H "sdp-inbound: false" -H "sdp-outbound: false"
check "HTTP 200 (got $STATUS)" '[ "$STATUS" = "200" ]'
check "both policies reported disabled" '[ "$(hdr x-sdp-inbound-policy-enabled)" = "false" ] && [ "$(hdr x-sdp-outbound-policy-enabled)" = "false" ]'

echo "🧪 [8] v2 templates: contact details, IBAN/SWIFT, bank account, API key, bare NRIC"
call "$KEY" '{"contents":[{"role":"user","parts":[{"text":"Contact Tan Wei Ming at weiming.tan@example.com. Customer S1234567D wants SGD 5,000 moved from DBS account 012-345678-9 to IBAN GB82WEST12345698765432 (SWIFT DBSSSGSGXXX). Config: api_key = \"AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe\". Reply OK."}]}]}' -H "sdp-outbound: false"
T9=$(hdr x-sdp-inbound-finding-types)
check "HTTP 200 (got $STATUS)" '[ "$STATUS" = "200" ]'
for t in PERSON_NAME EMAIL_ADDRESS SG_NRIC_FIN SG_BANK_ACCOUNT IBAN_CODE SWIFT_CODE GCP_API_KEY; do
  check "detects $t" 'echo "$T9" | grep -q "$t"'
done
echo "     ↳ types: $T9"

echo "🧪 [9] SDP X-ray (x-sdp-debug) is gated by the sdp_debug_allowed app attribute"
call "$KEY" '{"systemInstruction":{"parts":[{"text":"You are a retail banking support assistant. Values in square brackets are secure references; keep them as written."}]},"contents":[{"role":"user","parts":[{"text":"Refund customer Tan Wei Ming, NRIC S1234567D, card 4532015112830366."}]}]}' -H "x-sdp-debug: true"
check "HTTP 200 (got $STATUS)" '[ "$STATUS" = "200" ]'
check "X-SDP-Debug: enabled (got $(hdr x-sdp-debug))" '[ "$(hdr x-sdp-debug)" = "enabled" ]'
check "sdpAudit.inbound.modelSawParts has system + user" '[ "$(echo "$BODY" | jq -r "[.sdpAudit.inbound.modelSawParts[]?.role] | sort | join(\",\")")" = "system,user" ]'
check "X-ray body contains no raw NRIC/card" '! echo "$BODY" | grep -Eq "S1234567D|4532015112830366"'
check "X-SDP-Model header present ($(hdr x-sdp-model))" '[ -n "$(hdr x-sdp-model)" ]'
check "X-SDP-Timing well-formed ($(hdr x-sdp-timing))" 'hdr x-sdp-timing | grep -Eq "^gateway=[0-9]+;dlp_in=[0-9]+;model=[0-9]+;dlp_out=[0-9]+;total=[0-9]+$"'
if [ -n "$RKEY" ]; then
  call "$RKEY" '{"contents":[{"role":"user","parts":[{"text":"Say OK"}]}]}' -H "x-sdp-debug: true"
  check "restricted app: X-SDP-Debug denied (got $(hdr x-sdp-debug))" '[ "$(hdr x-sdp-debug)" = "denied" ]'
  check "restricted app: no sdpAudit in body" '[ "$(echo "$BODY" | jq -r "has(\"sdpAudit\")")" = "false" ]'
else
  bad "APIGEE_RESTRICTED_API_KEY unavailable - skipped"
fi
call "$KEY" '{"contents":[{"role":"user","parts":[{"text":"Say OK"}]}]}'
check "no debug header: X-SDP-Debug off, no sdpAudit" '[ "$(hdr x-sdp-debug)" = "off" ] && [ "$(echo "$BODY" | jq -r "has(\"sdpAudit\")")" = "false" ]'

echo "🧪 [10] Error bodies report the failing stage"
call - '{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}'
check "401 error has stage=gateway (got $(echo "$BODY" | jq -r .error.stage))" '[ "$(echo "$BODY" | jq -r .error.stage)" = "gateway" ]'

echo "🧪 [11] Cloud Logging audit trail (every request, no raw PII)"
sleep 8
LOGS=$(gcloud logging read "logName=\"projects/${ORG}/logs/apigee-sdp-logs\" AND timestamp>=\"$(date -u -v-5M +%Y-%m-%dT%H:%M:%SZ)\"" \
  --project="$ORG" --limit=40 --format=json 2>/dev/null || echo '[]')
N=$(echo "$LOGS" | jq 'length')
check "recent audit entries found ($N)" '[ "$N" -gt 0 ]'
check "clean requests are logged too" '[ "$(echo "$LOGS" | jq "[.[] | select(.jsonPayload.status==\"CLEAN_FORWARDED\")] | length")" -gt 0 ]'
check "no raw NRIC in any log entry" '! echo "$LOGS" | grep -Eq "S1234567D|S9876543C|S7654321F"'
echo "$LOGS" | jq -r '.[:6][] | "     ↳ \(.jsonPayload.direction) \(.jsonPayload.status) findings=\(.jsonPayload.findingsCount) app=\(.jsonPayload.app)"'

echo "======================================================================"
echo "Result: $PASS passed, $FAIL failed"
echo "(Fail-closed paths are covered by the JS unit harness; they require breaking DLP to test live.)"
echo "======================================================================"
[ "$FAIL" -eq 0 ]
