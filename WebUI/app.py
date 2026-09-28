#!/usr/bin/env python3
"""
Apigee + Google Cloud Sensitive Data Protection (SDP) Demonstration Web Server
Serves the demonstration UI and proxies requests to:
- gemini-sdp-proxy (https://YOUR_APIGEE_IP.nip.io/gemini-sdp-proxy)
Provides Live Inspection and Cloud Logging Audit Trail for Inbound & Outbound PII De-identification.

Security notes:
- Binds to 127.0.0.1 by default (set HOST=0.0.0.0 only inside a container / behind IAP).
- Raw prompts are never persisted; the audit store only keeps sanitized text.
- Calls the gateway with an Apigee API key (APIGEE_API_KEY, see setup-apigee-resources.sh).
"""

import datetime
import http.server
import json
import mimetypes
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("image/png", ".png")
import os
import random
import shutil
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", 8080))
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
AUDIT_LOGS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "audit_logs.json")
MAX_BODY_BYTES = 64 * 1024

APIGEE_PROXY_URL = os.environ.get("APIGEE_PROXY_URL", "https://YOUR_APIGEE_IP.nip.io/gemini-sdp-proxy")
APIGEE_API_KEY = os.environ.get("APIGEE_API_KEY", "")
GCP_PROJECT_ID = os.environ.get("GCP_PROJECT_ID", "YOUR_GCP_PROJECT_ID")
LOG_ID = os.environ.get("SDP_LOG_ID", "apigee-sdp-logs")
MODEL_NAME = os.environ.get("SDP_MODEL", "gemini-3.5-flash-lite")
INSPECT_TEMPLATE = os.environ.get("SDP_INSPECT_TEMPLATE", "inspect-sensitive-v2")
DEIDENTIFY_TEMPLATE = os.environ.get("SDP_DEIDENTIFY_TEMPLATE", "deidentify-sensitive-v2")
MAX_PROMPT_CHARS = 2000
MAX_SYSTEM_CHARS = 2000

# Verify the gateway certificate by default. Set APIGEE_TLS_INSECURE=1 only for a
# gateway with a self-signed certificate.
ssl_ctx = ssl.create_default_context()
if os.environ.get("APIGEE_TLS_INSECURE") == "1":
    ssl_ctx.check_hostname = False
    ssl_ctx.verify_mode = ssl.CERT_NONE

# Fields that may contain raw (un-sanitized) user input and must never be stored.
RAW_FIELDS = ("originalPrompt",)


class AuditStore:
    """Thread-safe store for Apigee SDP audit logs and telemetry metrics."""
    def __init__(self, filepath):
        self.filepath = filepath
        self.lock = threading.Lock()
        self.logs = []
        self._load()
        if len(self.logs) < 5:
            self.sync_cloud_logging()

    def _load(self):
        if os.path.exists(self.filepath):
            try:
                with open(self.filepath, "r", encoding="utf-8") as f:
                    self.logs = json.load(f)
            except Exception as e:
                print(f"Error reading {self.filepath}: {e}", file=sys.stderr)
                self.logs = []
        else:
            self.logs = []
        # Scrub any raw PII left over from older versions of this app.
        scrubbed = False
        for entry in self.logs:
            for field in RAW_FIELDS:
                if field in entry:
                    entry.pop(field)
                    scrubbed = True
            # Legacy local entries (no "policyEnabled" key) may hold raw text: inbound stored the raw
            # prompt as deidentifiedText. Cloud Logging entries (non "sdp-" ids) are proxy-sanitized.
            if ("policyEnabled" not in entry and str(entry.get("id", "")).startswith("sdp-")
                    and entry.get("deidentifiedText")):
                entry["deidentifiedText"] = ""
                scrubbed = True
        if scrubbed:
            self._save()

    def _save(self):
        try:
            with open(self.filepath, "w", encoding="utf-8") as f:
                json.dump(self.logs, f, indent=2)
        except Exception as e:
            print(f"Error saving {self.filepath}: {e}", file=sys.stderr)

    def record(self, direction, deidentified_text, detected, findings_count, finding_types, status,
               elapsed_ms, client_ip, request_id=None, policy_enabled=True):
        """Records one audit entry. Only sanitized text may be passed in deidentified_text."""
        with self.lock:
            entry = {
                "id": f"sdp-{int(time.time() * 1000)}-{random.randint(1000, 9999)}",
                "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "proxy": "gemini-sdp-proxy",
                "direction": direction,
                "clientIp": client_ip,
                "requestId": request_id,
                "policyEnabled": bool(policy_enabled),
                "sensitiveDataDetected": bool(detected),
                "findingsCount": str(findings_count),
                "findingTypes": finding_types or "NONE",
                "status": status,
                "deidentifiedText": deidentified_text or "",
                "elapsedMs": elapsed_ms,
                "logName": f"projects/{GCP_PROJECT_ID}/logs/apigee-sdp-logs"
            }
            self.logs.insert(0, entry)
            # Keep max 500 logs
            if len(self.logs) > 500:
                self.logs = self.logs[:500]
            self._save()
            return entry

    def _read_cloud_logging(self):
        """Returns recent apigee-sdp-logs entries: gcloud locally, Logging REST API on Cloud Run."""
        log_filter = f'logName="projects/{GCP_PROJECT_ID}/logs/{LOG_ID}"'
        if shutil.which("gcloud"):
            cmd = ["gcloud", "logging", "read", log_filter, f"--project={GCP_PROJECT_ID}",
                   "--limit=30", "--format=json"]
            result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=12)
            if result.returncode != 0 or not result.stdout.strip():
                return None
            return json.loads(result.stdout)
        # Cloud Run: token for the runtime service account from the metadata server.
        token_req = urllib.request.Request(
            "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
            headers={"Metadata-Flavor": "Google"})
        with urllib.request.urlopen(token_req, timeout=5) as r:
            token = json.loads(r.read())["access_token"]
        body = json.dumps({"resourceNames": [f"projects/{GCP_PROJECT_ID}"], "filter": log_filter,
                           "orderBy": "timestamp desc", "pageSize": 30}).encode()
        req = urllib.request.Request("https://logging.googleapis.com/v2/entries:list", data=body, method="POST",
                                     headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=12) as r:
            return json.loads(r.read()).get("entries", [])

    def sync_cloud_logging(self):
        """Fetches live logs from Google Cloud Logging for apigee-sdp-logs."""
        try:
            entries = self._read_cloud_logging()
            if entries is not None:
                with self.lock:
                    existing_ids = {l.get("id") for l in self.logs}
                    for e in entries:
                        insert_id = e.get("insertId")
                        if insert_id in existing_ids:
                            continue
                        payload = e.get("jsonPayload", {})
                        ts = e.get("timestamp")
                        self.logs.append({
                            "id": insert_id,
                            "timestamp": ts,
                            "proxy": payload.get("proxy", "gemini-sdp-proxy"),
                            "direction": payload.get("direction", "inbound"),
                            "clientIp": payload.get("clientIp", "unknown"),
                            "requestId": payload.get("requestId"),
                            "app": payload.get("app"),
                            "policyEnabled": payload.get("policyEnabled", True),
                            "sensitiveDataDetected": payload.get("sensitiveDataDetected", False),
                            "findingsCount": str(payload.get("findingsCount", "0")),
                            "findingTypes": payload.get("findingTypes", "NONE"),
                            "status": payload.get("status", "UNKNOWN"),
                            "deidentifiedText": payload.get("deidentifiedText", ""),
                            "totalTokens": payload.get("totalTokens"),
                            "elapsedMs": payload.get("targetLatencyMs", 0),
                            "logName": e.get("logName", f"projects/{GCP_PROJECT_ID}/logs/apigee-sdp-logs")
                        })
                    # Sort descending
                    self.logs.sort(key=lambda x: x.get("timestamp", ""), reverse=True)
                    self.logs = self.logs[:500]
                    self._save()
                return True
        except Exception as e:
            print(f"Failed to sync Cloud Logging: {e}", file=sys.stderr)
        return False

    def get_data(self, direction_filter="all"):
        with self.lock:
            filtered = self.logs
            if direction_filter in ["inbound", "outbound"]:
                filtered = [l for l in filtered if l.get("direction") == direction_filter]

            total_scans = len(filtered)
            inbound_scans = len([l for l in self.logs if l.get("direction") == "inbound"])
            outbound_scans = len([l for l in self.logs if l.get("direction") == "outbound"])
            inbound_detected = len([l for l in self.logs if l.get("direction") == "inbound" and l.get("sensitiveDataDetected")])
            outbound_detected = len([l for l in self.logs if l.get("direction") == "outbound" and l.get("sensitiveDataDetected")])
            total_detected = inbound_detected + outbound_detected

            # Count info types
            info_type_counts = {}
            for l in self.logs:
                ft = l.get("findingTypes", "")
                if ft and ft not in ("NONE", "DISABLED_BY_POLICY"):
                    for t in [x.strip() for x in ft.split(",")]:
                        if t:
                            info_type_counts[t] = info_type_counts.get(t, 0) + 1

            return {
                "logs": filtered[:100],
                "metrics": {
                    "total_scans": total_scans,
                    "inbound_scans": inbound_scans,
                    "outbound_scans": outbound_scans,
                    "inbound_detected": inbound_detected,
                    "outbound_detected": outbound_detected,
                    "total_detected": total_detected,
                    "deidentified_applied": total_detected,
                    "info_type_distribution": info_type_counts
                }
            }


audit_store = AuditStore(AUDIT_LOGS_FILE)


def _status_for(direction, enabled, detected):
    if not enabled:
        return "BYPASSED_BY_POLICY"
    if direction == "inbound":
        return "DEIDENTIFIED_AND_FORWARDED" if detected else "CLEAN_FORWARDED"
    return "DEIDENTIFIED_AND_RETURNED" if detected else "CLEAN_RETURNED"


def _parse_timing(value):
    """Parses 'gateway=4;dlp_in=180;model=900;dlp_out=150;total=1250' into a dict of ints."""
    timing = {}
    for item in (value or "").split(";"):
        key, _, num = item.partition("=")
        if key.strip() and num.strip().isdigit():
            timing[key.strip()] = int(num.strip())
    return timing


class DemoHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Concise logging
        print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] {self.command} {self.path} {args[1] if len(args) > 1 else ''}")

    def _set_security_headers(self, content_type="application/json"):
        # Same-origin only: no CORS headers are emitted.
        self.send_header("Content-Type", content_type)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()

    def _send_json(self, status, payload):
        self.send_response(status)
        self._set_security_headers("application/json")
        self.wfile.write(json.dumps(payload).encode("utf-8"))

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        clean_path = parsed.path

        if clean_path in ["", "/"]:
            clean_path = "/index.html"

        if clean_path == "/api/admin/logs":
            qs = urllib.parse.parse_qs(parsed.query)
            direction = qs.get("direction", ["all"])[0]
            self._send_json(200, audit_store.get_data(direction_filter=direction))
            return

        if clean_path == "/api/config":
            # Display-only settings for the UI. Never include the API key.
            self._send_json(200, {
                "proxyUrl": APIGEE_PROXY_URL,
                "project": GCP_PROJECT_ID,
                "logName": f"projects/{GCP_PROJECT_ID}/logs/{LOG_ID}",
                "logId": LOG_ID,
                "model": MODEL_NAME,
                "inspectTemplate": INSPECT_TEMPLATE,
                "deidentifyTemplate": DEIDENTIFY_TEMPLATE,
                "maxPromptChars": MAX_PROMPT_CHARS,
                "apiKeyConfigured": bool(APIGEE_API_KEY)
            })
            return

        # Serve static file
        local_path = os.path.normpath(os.path.join(STATIC_DIR, clean_path.lstrip("/")))
        if not local_path.startswith(STATIC_DIR + os.sep) or not os.path.exists(local_path) or os.path.isdir(local_path):
            self.send_response(404)
            self._set_security_headers("text/plain")
            self.wfile.write(b"404 Not Found")
            return

        mime_type, _ = mimetypes.guess_type(local_path)
        if not mime_type:
            mime_type = "application/octet-stream"

        try:
            with open(local_path, "rb") as f:
                content = f.read()
            self.send_response(200)
            self._set_security_headers(mime_type)
            self.wfile.write(content)
        except Exception:
            self.send_response(500)
            self._set_security_headers("text/plain")
            self.wfile.write(b"500 Internal Error")

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        clean_path = parsed.path

        try:
            content_len = int(self.headers.get("Content-Length", 0))
        except ValueError:
            content_len = 0
        if content_len > MAX_BODY_BYTES:
            self._send_json(413, {"error": f"Request body exceeds {MAX_BODY_BYTES} bytes"})
            return
        post_body = self.rfile.read(content_len).decode("utf-8") if content_len > 0 else "{}"

        if clean_path == "/api/admin/refresh":
            ok = audit_store.sync_cloud_logging()
            self._send_json(200, {"success": ok, "data": audit_store.get_data()})
            return

        if clean_path == "/api/generate":
            try:
                req_data = json.loads(post_body)
            except Exception:
                req_data = {"prompt": post_body}

            prompt = req_data.get("prompt", "")
            if not isinstance(prompt, str) or not prompt.strip():
                self._send_json(400, {"error": "Prompt cannot be empty"})
                return
            if len(prompt) > MAX_PROMPT_CHARS:
                self._send_json(400, {"error": f"Prompt exceeds {MAX_PROMPT_CHARS} characters"})
                return
            system_instruction = req_data.get("systemInstruction") or ""
            if not isinstance(system_instruction, str) or len(system_instruction) > MAX_SYSTEM_CHARS:
                self._send_json(400, {"error": f"systemInstruction must be text up to {MAX_SYSTEM_CHARS} characters"})
                return

            sdp_inbound = req_data.get("sdp-inbound", req_data.get("sdp_inbound", True))
            sdp_outbound = req_data.get("sdp-outbound", req_data.get("sdp_outbound", True))

            if isinstance(sdp_inbound, str):
                sdp_inbound = sdp_inbound.lower() not in ["false", "0", "no", "off"]
            if isinstance(sdp_outbound, str):
                sdp_outbound = sdp_outbound.lower() not in ["false", "0", "no", "off"]

            self._handle_generate(prompt, sdp_inbound=bool(sdp_inbound), sdp_outbound=bool(sdp_outbound),
                                  system_instruction=system_instruction.strip())
            return

        self._send_json(404, {"error": "Unknown API endpoint"})

    def _handle_generate(self, prompt, sdp_inbound=True, sdp_outbound=True, system_instruction=""):
        inbound_str = "true" if sdp_inbound else "false"
        outbound_str = "true" if sdp_outbound else "false"
        client_ip = self.client_address[0]

        gemini_payload = {
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {"text": prompt}
                    ]
                }
            ]
        }
        if system_instruction:
            # The gateway de-identifies systemInstruction parts too.
            gemini_payload["systemInstruction"] = {"parts": [{"text": system_instruction}]}

        req = urllib.request.Request(
            APIGEE_PROXY_URL,
            data=json.dumps(gemini_payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "x-api-key": APIGEE_API_KEY,
                "sdp-inbound": inbound_str,
                "sdp-outbound": outbound_str,
                # Sanitized X-ray: honoured only because this app has sdp_debug_allowed=true.
                "x-sdp-debug": "true"
            },
            method="POST"
        )

        start_time = time.time()
        try:
            with urllib.request.urlopen(req, context=ssl_ctx, timeout=45) as resp:
                elapsed_ms = int((time.time() - start_time) * 1000)
                resp_status = resp.status
                resp_bytes = resp.read()
                resp_headers = dict(resp.headers)
                hdr = {k.lower(): v for k, v in resp_headers.items()}

                resp_json = {}
                try:
                    resp_json = json.loads(resp_bytes.decode("utf-8"))
                except Exception:
                    pass

                # Extract telemetry headers
                inbound_policy_enabled = hdr.get("x-sdp-inbound-policy-enabled", inbound_str).lower() == "true"
                inbound_detected = hdr.get("x-sdp-inbound-sensitive-data-detected", "false").lower() == "true"
                inbound_count = hdr.get("x-sdp-inbound-findings-count", "0")
                inbound_types = hdr.get("x-sdp-inbound-finding-types", "NONE")

                outbound_policy_enabled = hdr.get("x-sdp-outbound-policy-enabled", outbound_str).lower() == "true"
                outbound_detected = hdr.get("x-sdp-outbound-sensitive-data-detected", "false").lower() == "true"
                outbound_count = hdr.get("x-sdp-outbound-findings-count", "0")
                outbound_types = hdr.get("x-sdp-outbound-finding-types", "NONE")
                request_id = hdr.get("x-request-id")

                # Extract model text
                model_text = ""
                if resp_json.get("candidates"):
                    candidate = resp_json["candidates"][0]
                    parts = candidate.get("content", {}).get("parts", [])
                    model_text = "\n".join([p.get("text", "") for p in parts if p.get("text")])

                # Sanitized X-ray from the gateway (only sanitized text; see SDP-Finalize-Response.js).
                sdp_audit = resp_json.pop("sdpAudit", None) if isinstance(resp_json, dict) else None
                model_saw = ((sdp_audit or {}).get("inbound") or {}).get("modelSawParts") or []
                sanitized_inbound = "\n".join(p.get("text", "") for p in model_saw if isinstance(p, dict))

                # Record every request (clean, sanitized and bypassed) for an accurate audit trail.
                # The raw prompt is never stored; only gateway-sanitized text when something was masked.
                audit_store.record(
                    direction="inbound",
                    deidentified_text=sanitized_inbound if (inbound_policy_enabled and inbound_detected) else None,
                    detected=inbound_detected,
                    findings_count=inbound_count,
                    finding_types=inbound_types,
                    status=_status_for("inbound", inbound_policy_enabled, inbound_detected),
                    elapsed_ms=elapsed_ms,
                    client_ip=client_ip,
                    request_id=request_id,
                    policy_enabled=inbound_policy_enabled
                )
                audit_store.record(
                    direction="outbound",
                    # Model output is only stored when outbound SDP sanitized it.
                    deidentified_text=model_text if (outbound_policy_enabled and outbound_detected) else None,
                    detected=outbound_detected,
                    findings_count=outbound_count,
                    finding_types=outbound_types,
                    status=_status_for("outbound", outbound_policy_enabled, outbound_detected),
                    elapsed_ms=elapsed_ms,
                    client_ip=client_ip,
                    request_id=request_id,
                    policy_enabled=outbound_policy_enabled
                )

                out_payload = {
                    "success": True,
                    "status_code": resp_status,
                    "elapsed_ms": elapsed_ms,
                    "request_id": request_id,
                    "inbound": {
                        "policyEnabled": inbound_policy_enabled,
                        "sensitiveDataDetected": inbound_detected,
                        "findingsCount": inbound_count,
                        "findingTypes": inbound_types,
                        "originalPrompt": prompt
                    },
                    "outbound": {
                        "policyEnabled": outbound_policy_enabled,
                        "sensitiveDataDetected": outbound_detected,
                        "findingsCount": outbound_count,
                        "findingTypes": outbound_types,
                        "modelResponseText": model_text
                    },
                    "sdp_audit": sdp_audit,
                    "debug_status": hdr.get("x-sdp-debug", "off"),
                    "timing": _parse_timing(hdr.get("x-sdp-timing", "")),
                    "model_version": resp_json.get("modelVersion", hdr.get("x-sdp-model", MODEL_NAME)),
                    "usage": resp_json.get("usageMetadata", {}),
                    "raw_response": resp_json,
                    "headers": resp_headers
                }
                self._send_json(200, out_payload)

        except urllib.error.HTTPError as e:
            elapsed_ms = int((time.time() - start_time) * 1000)
            err_body = e.read().decode("utf-8", errors="replace")
            gateway_error = {}
            try:
                gateway_error = json.loads(err_body).get("error", {})
            except Exception:
                pass
            self._send_json(e.code, {
                "success": False,
                "status_code": e.code,
                "elapsed_ms": elapsed_ms,
                "error_status": gateway_error.get("status", "GATEWAY_ERROR"),
                "error": gateway_error.get("message") or f"Gateway returned HTTP {e.code}",
                "stage": gateway_error.get("stage"),
                "request_id": gateway_error.get("requestId")
            })

        except Exception as e:
            elapsed_ms = int((time.time() - start_time) * 1000)
            self._send_json(502, {
                "success": False,
                "status_code": 502,
                "elapsed_ms": elapsed_ms,
                "error_status": "GATEWAY_UNREACHABLE",
                "error": f"Could not reach the Apigee gateway: {e.__class__.__name__}"
            })


def run():
    server_address = (HOST, PORT)
    # Threaded server so a slow model call never blocks the dashboard.
    httpd = http.server.ThreadingHTTPServer(server_address, DemoHandler)
    httpd.daemon_threads = True
    print(f"🚀 Apigee + Sensitive Data Protection Web UI running at http://localhost:{PORT} (bound to {HOST})")
    print(f"Connected to Apigee Proxy: {APIGEE_PROXY_URL}")
    if not APIGEE_API_KEY:
        print("⚠️  APIGEE_API_KEY is not set - the gateway will reject requests with 401. "
              "Run ./setup-apigee-resources.sh to create WebUI/.env.", file=sys.stderr)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server.")
        httpd.server_close()


if __name__ == "__main__":
    run()
