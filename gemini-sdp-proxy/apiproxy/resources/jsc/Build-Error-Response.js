/*
 * Build-Error-Response.js
 * Maps any fault to a consistent, sanitized JSON error. Never echoes fault strings
 * or upstream error bodies (which can contain prompt text) back to the client.
 */
var faultName = context.getVariable("fault.name") || "UnknownFault";
var status = parseInt(context.getVariable("error.status.code"), 10) || 500;
var code = "INTERNAL";
var message = "An internal gateway error occurred.";

var API_KEY_FAULTS = [
  "FailedToResolveAPIKey", "InvalidApiKey", "InvalidApiKeyForGivenResource",
  "ApiKeyNotApproved", "invalid_client-app_not_approved", "DeveloperStatusNotActive",
  "CompanyStatusNotActive", "consumer_key_expired", "AppGroupStatusNotActive"
];
var RATE_FAULTS = ["SpikeArrestViolation", "LLMTokenQuotaViolation", "QuotaViolation"];

if (context.getVariable("sdp.bypass.denied") === "true") {
  status = 403;
  code = "PERMISSION_DENIED";
  message = "This app is not permitted to disable Sensitive Data Protection (sdp-inbound/sdp-outbound).";
} else if (context.getVariable("sdp.error") === "true") {
  status = 502;
  code = "SDP_UNAVAILABLE";
  message = "Sensitive Data Protection could not verify this content, so the request was blocked (fail-closed).";
} else if (API_KEY_FAULTS.indexOf(faultName) !== -1) {
  status = 401;
  code = "UNAUTHENTICATED";
  message = "A valid API key is required in the x-api-key header.";
} else if (RATE_FAULTS.indexOf(faultName) !== -1) {
  status = 429;
  code = "RESOURCE_EXHAUSTED";
  message = faultName === "LLMTokenQuotaViolation"
    ? "LLM token quota exceeded for this app. Try again later."
    : "Request rate limit exceeded for this app. Slow down and retry.";
} else if (faultName === "ErrorResponseCode") {
  // Upstream (Vertex AI) error: keep the status, expose only the canonical status name.
  code = "UPSTREAM_ERROR";
  try {
    var upstream = JSON.parse(context.getVariable("error.content") || "{}");
    if (upstream && upstream.error && upstream.error.status) {
      code = String(upstream.error.status);
    }
  } catch (ignored) {
    // Non-JSON upstream body: keep the generic code.
  }
  message = "The model backend returned an error.";
}

var PHRASES = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
  429: "Too Many Requests", 500: "Internal Server Error", 502: "Bad Gateway",
  503: "Service Unavailable", 504: "Gateway Timeout" };

var requestId = context.getVariable("messageid");

// Coarse pipeline stage for the demo UI (no internal detail).
var errStage = String(context.getVariable("sdp.error.stage") || "");
var stage = "gateway";
if (context.getVariable("sdp.bypass.denied") === "true") {
  stage = "sdp_in";
} else if (context.getVariable("sdp.error") === "true") {
  stage = errStage.indexOf("outbound") !== -1 ? "sdp_out" : "sdp_in";
} else if (faultName === "ErrorResponseCode") {
  stage = "model";
}

context.setVariable("sdperr.status", String(status));
context.setVariable("sdperr.phrase", PHRASES[status] || "Error");
context.setVariable("sdperr.body", JSON.stringify({
  error: { code: status, status: code, message: message, reason: faultName, stage: stage, requestId: requestId }
}));

// Audit trail for fail-closed blocks and denied bypass attempts.
if (context.getVariable("sdp.error") === "true" || context.getVariable("sdp.bypass.denied") === "true") {
  context.setVariable("sdperr.log", JSON.stringify({
    proxy: context.getVariable("apiproxy.name"),
    direction: String(context.getVariable("sdp.error.stage") || "").indexOf("outbound") !== -1 ? "outbound" : "inbound",
    organization: context.getVariable("organization.name"),
    environment: context.getVariable("environment.name"),
    requestId: requestId,
    clientIp: context.getVariable("client.ip"),
    app: context.getVariable("verifyapikey.VA-Verify-API-Key.app.name"),
    timestamp: new Date().toISOString(),
    sensitiveDataDetected: false,
    findingsCount: 0,
    findingTypes: "NONE",
    status: code === "PERMISSION_DENIED" ? "BLOCKED_BYPASS_DENIED" : "BLOCKED_SDP_UNAVAILABLE",
    errorStage: context.getVariable("sdp.error.stage") || null,
    errorDetail: context.getVariable("sdp.error.detail") || null
  }));
}
