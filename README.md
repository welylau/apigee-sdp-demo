# Apigee + Sensitive Data Protection (Cloud DLP) + Cloud Logging Demo

An enterprise AI Gateway demonstration combining **Apigee X**, **Google Cloud Sensitive Data Protection (Cloud DLP)**, **Cloud Logging**, and **Vertex AI Gemini 3.5 Flash-Lite**.

---

## 🏛️ Architecture Overview

```
Client (x-api-key + prompt with PII)
           │
           ▼
┌──────────────────────────────────────────────────────────────┐
│        Apigee Gateway: gemini-sdp-proxy                      │
│                                                              │
│  [ PREFLOW: Identity, Abuse Control & Inbound Guardrail ]    │
│   (1) VerifyAPIKey  → app identity (x-api-key)               │
│   (2) SpikeArrest   → 30 req/min per app                     │
│   (3) LLMTokenQuota → 50k tokens/hour per app (enforce)      │
│   (4) Collect EVERY text part (systemInstruction + all turns)│
│   (5) ONE ServiceCallout → DLP content:deidentify            │
│       (table item: one row per part, per-part write-back)    │
│   (6) Fail closed → 502 SDP_UNAVAILABLE on any DLP problem   │
│   (7) MessageLogging → Cloud Logging (every request)         │
│                                                              │
│  [ TARGET ENDPOINT ]                                         │
│   (8) Vertex AI (global) gemini-3.5-flash-lite               │
│       URL built from the "sdp" property set                  │
│                                                              │
│  [ POSTFLOW: Outbound Guardrail ]                            │
│   (9)  LLMTokenQuota count (usageMetadata.totalTokenCount)   │
│   (10) De-identify ALL candidates / parts (one DLP call)     │
│   (11) Fail closed, audit log (tokens, latency, findings)    │
│   (12) Telemetry headers X-SDP-* and X-Request-Id            │
│                                                              │
│  [ DefaultFaultRule ] sanitized JSON errors, never echoes    │
│   upstream bodies (401 / 403 / 429 / 502 / upstream status)  │
└──────────────────────────────────────────────────────────────┘
           │
           ▼
Client (Sanitized Gemini Response + SDP Telemetry Headers)
```

---

## 🔒 1. Sensitive Data Protection (Cloud DLP) Configuration

* **Location**: `asia-southeast1` (Singapore)
* **Templates are code**: [`dlp/inspect-sensitive-v2.json`](dlp/inspect-sensitive-v2.json) and [`dlp/deidentify-sensitive-v2.json`](dlp/deidentify-sensitive-v2.json), applied idempotently by [`setup-dlp-templates.sh`](setup-dlp-templates.sh).
* **Inspect Template** `inspect-sensitive-v2`:
  - Built-in: `SINGAPORE_NATIONAL_REGISTRATION_ID_NUMBER`, `SINGAPORE_PASSPORT`, `PASSPORT`, `CREDIT_CARD_NUMBER`, `CREDIT_CARD_DATA`, `CREDIT_CARD_TRACK_NUMBER`, `IBAN_CODE`, `SWIFT_CODE`, `PERSON_NAME`, `EMAIL_ADDRESS`, `PHONE_NUMBER`, `STREET_ADDRESS`, `DATE_OF_BIRTH`, `GCP_API_KEY`, `GCP_CREDENTIALS`, `AUTH_TOKEN`, `PASSWORD`
  - Custom `SG_NRIC_FIN`: regex `\b[STFGM]\d{7}[A-Z]\b` (catches IDs typed without the word "NRIC").
  - Custom `SG_BANK_ACCOUNT`: `\b\d{3}-\d{5,6}-\d{1,3}\b`, boosted to VERY_LIKELY by hotwords (account, DBS, OCBC, UOB…).
  - `PERSON_NAME` / `STREET_ADDRESS` require LIKELY; exclusion rules stop double labels (name inside email, passport vs NRIC, card data vs card number).
* **De-identify Template** `deidentify-sensitive-v2`: `replaceWithInfoTypeConfig` for every infoType.
  - `S1234567D` → `[SINGAPORE_NATIONAL_REGISTRATION_ID_NUMBER]`, bare `S1234567D` → `[SG_NRIC_FIN]`
  - `weiming.tan@example.com` → `[EMAIL_ADDRESS]`, `012-345678-9` (DBS) → `[SG_BANK_ACCOUNT]`
* **Rollback**: the original `inspect-sensitve` / `deidentify-sensitve` templates are untouched; swap the two template lines in `sdp.properties` (commented there) and redeploy.
* **Known limits**: multi-token names can become `[PERSON_NAME] [PERSON_NAME]`; OAuth `ya29.` tokens are not reliably detected; card numbers must pass Luhn.
* **Data residency note**: PII is masked in `asia-southeast1` *before* the prompt reaches the Vertex AI `global` endpoint.

---

## 🚀 2. Apigee Proxy: `gemini-sdp-proxy`

* **Organization**: `YOUR_GCP_PROJECT_ID`
* **Environment**: `default-dev`
* **Base Path**: `/gemini-sdp-proxy`
* **Endpoint URL**: `https://YOUR_APIGEE_IP.nip.io/gemini-sdp-proxy`
* **Authentication**: `x-api-key` header (API product `sdp-demo-product`)
* **Backend Model**: Vertex AI `gemini-3.5-flash-lite:generateContent` (global endpoint)
* **Runtime Service Account**: `sa-apigee-aiservices@YOUR_GCP_PROJECT_ID.iam.gserviceaccount.com`
* **Configuration**: [`resources/properties/sdp.properties`](gemini-sdp-proxy/apiproxy/resources/properties/sdp.properties) — DLP project/region/templates and Vertex project/location/model.

### Consumer apps (created by `setup-apigee-resources.sh`)

| App | `sdp_bypass_allowed` | `sdp_debug_allowed` | Behaviour |
|---|---|---|---|
| `sdp-demo-webui` | `true` | `true` | May switch SDP off (`sdp-inbound=false` / `sdp-outbound=false`) and may request the SDP X-ray (`x-sdp-debug: true`) |
| `sdp-demo-restricted` | *(unset)* | *(unset)* | SDP always enforced; bypass attempts return **403 PERMISSION_DENIED**; `x-sdp-debug` is ignored (`X-SDP-Debug: denied`) |

### Observability headers & SDP X-ray

* `X-SDP-Timing: gateway=..;dlp_in=..;model=..;dlp_out=..;total=..` (ms) on every response; `X-SDP-Model` shows the backend model.
* With `x-sdp-debug: true` **and** `sdp_debug_allowed=true`, the response body gains an `sdpAudit` object: the exact (sanitized) parts Gemini received, with roles, plus findings per direction, templates and timings. Raw values are never included. The header is stripped before the call to Vertex AI.
* Error bodies include `error.stage` (`gateway`, `sdp_in`, `model`, `sdp_out`).

### Proxy Execution Pipeline

| Direction | Policy Name | Type | Purpose |
|---|---|---|---|
| **Inbound** | `VA-Verify-API-Key` | VerifyAPIKey | Validates `x-api-key`, resolves the app and its attributes. |
| **Inbound** | `SA-Spike-Arrest` | SpikeArrest | 30 requests/minute per app. |
| **Inbound** | `LTQ-Enforce-Tokens` | LLMTokenQuota | Enforces 50k tokens/hour per app (shared counter). |
| **Inbound** | `JS-SDP-Prepare-Inbound` | JavaScript | Gated bypass toggles, normalises request, collects every text part, builds DLP table payload. |
| **Inbound** | `RF-SDP-Bypass-Forbidden` | RaiseFault | *(Conditional)* 403 when a restricted app tries to switch SDP off. |
| **Inbound** | `SC-SDP-Deidentify-Inbound` | ServiceCallout | One DLP `content:deidentify` call (findings come from `transformationSummaries`). |
| **Inbound** | `JS-SDP-Apply-Inbound` | JavaScript | Validates the DLP response and writes each sanitized row back to its own part. |
| **Inbound** | `RF-SDP-Unavailable` | RaiseFault | *(Conditional)* Fail closed: 502 if SDP could not verify the content. |
| **Inbound** | `ML-Log-SDP-Inbound` | MessageLogging | Audit entry for **every** request (clean, de-identified, bypassed). |
| **Inbound** | `AM-Prepare-Gemini-Request` | AssignMessage | Strips client credentials and toggle headers. |
| **Backend** | `AM-Set-Target-URL` + `TargetEndpoint` | AssignMessage / HTTPTarget | Vertex AI URL from property set; Google OAuth token. |
| **Outbound** | `LTQ-Count-Tokens` | LLMTokenQuota | Counts `usageMetadata.totalTokenCount`. |
| **Outbound** | `JS-SDP-Prepare-Outbound` | JavaScript | Collects text parts across **all** candidates; fails closed on non-JSON. |
| **Outbound** | `SC-SDP-Deidentify-Outbound` | ServiceCallout | One DLP `content:deidentify` call on model output. |
| **Outbound** | `JS-SDP-Apply-Outbound` | JavaScript | Validates and writes sanitized text back per part. |
| **Outbound** | `RF-SDP-Unavailable` | RaiseFault | *(Conditional)* Fail closed. |
| **Outbound** | `ML-Log-SDP-Outbound` | MessageLogging | Audit entry incl. token usage and model latency. |
| **Outbound** | `JS-SDP-Finalize-Response` | JavaScript | Builds `X-SDP-Timing`; injects `sdpAudit` only for debug-enabled apps. |
| **Outbound** | `AM-Set-SDP-Response-Headers` | AssignMessage | `X-SDP-*` telemetry and `X-Request-Id`. |
| **Fault** | `JS-Build-Error-Response` → `ML-Log-SDP-Error` → `AM-Set-Error-Response` | DefaultFaultRule | Sanitized error JSON, audit of blocked requests. |

Shared JavaScript lives in [`sdp-common.js`](gemini-sdp-proxy/apiproxy/resources/jsc/sdp-common.js) (included via `<IncludeURL>`).

---

## 💻 3. Interactive Web Demonstration UI

The Web UI is located in [`WebUI/`](WebUI/) and follows the Google Cloud Enterprise theme from `https://sanitize.apigee-demo.com/`.

### Features
* **Dual Theme**: Light & Dark mode toggle.
* **Resizable Splitter**: Ergonomic draggable divider between controls and live inspector.
* **Preset Library (14 scenarios)**: banking (refund, transfer, CVV), identity (FIN/passport, bare NRIC), clinic, HR, secrets, Chinese/Malay, and two outbound stories (model-invented customer, split-and-reassemble evasion). Business presets carry an assistant persona (bank, clinic, HR; sent as `systemInstruction` and inspected by SDP too) so Gemini completes the task on masked data, and every preset has an expected-infoTypes **self-test** badge.
* **Live pipeline**: Client → Apigee → SDP In → Gemini → SDP Out → Client, with per-hop timings and a latency bar showing SDP's share.
* **SDP X-ray**: three columns (what you typed with PII highlighted, what Gemini actually saw with system/user roles, what outbound SDP caught), plus a Cloud Logging deep link per request.
* **Compare OFF vs ON**: runs the same prompt twice in parallel and shows the unprotected vs protected result side by side.
* **Present mode**: a 6-step guided story (← → navigate, Enter runs, Esc exits).
* **Security Audit Logs drawer**: Dynamic sync with Google Cloud Logging (`apigee-sdp-logs`), KPI metrics cards, and search filters.
* **Zero Dependency Backend**: Python 3 standard library (`ThreadingHTTPServer`).

### Security defaults
* Binds to `127.0.0.1` (set `HOST=0.0.0.0` only in a container / behind IAP); no CORS.
* Raw prompts are **never persisted**; the local audit store keeps sanitized text only (older entries are scrubbed on start).
* API key is read from `WebUI/.env` (gitignored, mode 600).

### Starting the Web UI
```bash
./setup-apigee-resources.sh   # once: creates product/apps and WebUI/.env
./WebUI/run-ui.sh
```
Open **`http://localhost:8080`** (or `8081` if 8080 is busy).

---

## 🧪 4. Regression Tests

```bash
./test-demo.sh
```
Asserts: 401 without a key, clean and PII prompts, **multi-turn + systemInstruction masking**, outbound masking, bypass denied (403) vs allowed, v2 detector coverage (name, email, bare NRIC, SG bank account, IBAN, SWIFT, API key), X-ray gating per app (`enabled` / `denied` / `off`), `X-SDP-Timing` format, `error.stage`, and a complete Cloud Logging audit trail with no raw PII.

### Manual cURL Verification

#### 1. Inbound PII Request:
```bash
curl -s -k -i -X POST "https://YOUR_APIGEE_IP.nip.io/gemini-sdp-proxy" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $APIGEE_API_KEY" \
  -d '{
    "contents": [
      {
        "role": "user",
        "parts": [
          {
            "text": "Verify customer profile: Singapore NRIC S9876543A, Passport K1234567Z, Card 4532015112830366. Summarize the details."
          }
        ]
      }
    ]
  }'
```

#### 2. Query Cloud Logging Audit Trail:
```bash
gcloud logging read 'logName="projects/YOUR_GCP_PROJECT_ID/logs/apigee-sdp-logs"' \
  --project=YOUR_GCP_PROJECT_ID \
  --limit=5 \
  --format="json"
```

---

## 🛠️ 5. Deployment

```bash
gcloud auth application-default login   # Apigee/Vertex reject the plain gcloud user token
./setup-dlp-templates.sh                # idempotent: creates/updates the v2 DLP templates
./setup-apigee-resources.sh             # idempotent: product, developer, apps + attributes, WebUI/.env
./deploy.sh                             # upload + deploy gemini-sdp-proxy
```
