/*
 * SDP-Prepare-Inbound.js
 *  1. Resolves the sdp-inbound / sdp-outbound toggles (query -> header -> body) and
 *     only honours "off" when the calling app has sdp_bypass_allowed=true.
 *  2. Normalises the request into Gemini generateContent format and strips the
 *     toggle fields so Vertex AI never sees them.
 *  3. Collects EVERY text part (systemInstruction + all turns) and builds a single
 *     DLP deidentify table request (one row per part).
 */
try {
  var rawContent = context.getVariable("request.content");
  var body = null;
  try {
    body = rawContent ? JSON.parse(rawContent) : null;
  } catch (parseErr) {
    body = null;
  }

  var bodyIn = body && typeof body === "object" ? body["sdp-inbound"] : null;
  var bodyOut = body && typeof body === "object" ? body["sdp-outbound"] : null;
  var inboundParam = SDP.firstNonBlank(
    context.getVariable("request.queryparam.sdp-inbound"),
    context.getVariable("request.header.sdp-inbound"),
    bodyIn);
  var outboundParam = SDP.firstNonBlank(
    context.getVariable("request.queryparam.sdp-outbound"),
    context.getVariable("request.header.sdp-outbound"),
    bodyOut);

  var wantsInboundOff = SDP.isOff(inboundParam);
  var wantsOutboundOff = SDP.isOff(outboundParam);
  var bypassAllowed = String(
    context.getVariable("verifyapikey.VA-Verify-API-Key.app.sdp_bypass_allowed")).toLowerCase() === "true";

  if ((wantsInboundOff || wantsOutboundOff) && !bypassAllowed) {
    context.setVariable("sdp.bypass.denied", "true");
  } else {
    context.setVariable("sdp.bypass.denied", "false");
  }

  var inboundEnabled = !(wantsInboundOff && bypassAllowed);
  var outboundEnabled = !(wantsOutboundOff && bypassAllowed);
  context.setVariable("sdp.inbound.enabled", inboundEnabled ? "true" : "false");
  context.setVariable("sdp.outbound.enabled", outboundEnabled ? "true" : "false");

  // Per-stage timing (reported in X-SDP-Timing). inEnd is overwritten by SDP-Apply-Inbound.
  var now = String(Date.now());
  context.setVariable("sdp.t.in_start", now);
  context.setVariable("sdp.t.in_end", now);

  // X-ray debug view: only apps with sdp_debug_allowed=true get sanitized parts back.
  var wantsDebug = String(context.getVariable("request.header.x-sdp-debug") || "").toLowerCase() === "true";
  var debugAllowed = String(
    context.getVariable("verifyapikey.VA-Verify-API-Key.app.sdp_debug_allowed")).toLowerCase() === "true";
  context.setVariable("sdp.debug.status", !wantsDebug ? "off" : (debugAllowed ? "enabled" : "denied"));

  // Normalise to Gemini format.
  if (body && typeof body === "object") {
    delete body["sdp-inbound"];
    delete body["sdp-outbound"];
    if (!Array.isArray(body.contents) && typeof body.prompt === "string") {
      body = { contents: [{ role: "user", parts: [{ text: body.prompt }] }] };
    }
  } else if (rawContent && String(rawContent).trim().length > 0) {
    body = { contents: [{ role: "user", parts: [{ text: String(rawContent) }] }] };
  } else {
    body = { contents: [] };
  }
  context.setVariable("request.content", JSON.stringify(body));

  var refs = SDP.collectRequestParts(body);
  context.setVariable("sdp.inbound.parts.count", String(refs.length));
  context.setVariable("sdp.inbound.findings.detected", "false");
  context.setVariable("sdp.inbound.findings.count", "0");

  var logStatus = null;
  if (!inboundEnabled) {
    context.setVariable("sdp.inbound.has_text", "false");
    context.setVariable("sdp.inbound.findings.types", "DISABLED_BY_POLICY");
    logStatus = "BYPASSED_BY_POLICY";
  } else if (refs.length === 0) {
    context.setVariable("sdp.inbound.has_text", "false");
    context.setVariable("sdp.inbound.findings.types", "NONE");
    logStatus = "NO_TEXT_FORWARDED";
  } else {
    context.setVariable("sdp.inbound.has_text", "true");
    context.setVariable("sdp.inbound.findings.types", "NONE");
    context.setVariable("sdp.inbound.parts.refs", JSON.stringify(refs));
    var payload = SDP.buildDeidentifyPayload(
      SDP.readTexts(body, refs),
      sdpProp("inspect_template"),
      sdpProp("deidentify_template"));
    context.setVariable("sdp.inbound.deidentify.payload", JSON.stringify(payload));
  }

  // Audit entry for requests that are not inspected (inspected requests are logged by SDP-Apply-Inbound).
  if (logStatus) {
    context.setVariable("sdp.inbound.log", SDP.buildLogEntry(sdpLogBase("inbound"), {
      policyEnabled: inboundEnabled,
      sensitiveDataDetected: false,
      findingsCount: 0,
      findingTypes: inboundEnabled ? "NONE" : "DISABLED_BY_POLICY",
      partsInspected: 0,
      status: logStatus
    }));
  }
} catch (e) {
  sdpFail("prepare_inbound", e);
}
