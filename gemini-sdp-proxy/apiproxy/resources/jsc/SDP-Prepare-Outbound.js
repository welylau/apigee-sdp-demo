/*
 * SDP-Prepare-Outbound.js
 * Collects every text part across ALL candidates of the Gemini response and builds
 * a DLP deidentify table request. A non-JSON response cannot be inspected, so it
 * fails closed when outbound SDP is enabled.
 */
try {
  var tOut = String(Date.now());
  context.setVariable("sdp.t.out_start", tOut);
  context.setVariable("sdp.t.out_end", tOut);
  var outboundEnabled = context.getVariable("sdp.outbound.enabled") !== "false";
  context.setVariable("sdp.outbound.enabled", outboundEnabled ? "true" : "false");
  context.setVariable("sdp.outbound.findings.detected", "false");
  context.setVariable("sdp.outbound.findings.count", "0");
  context.setVariable("sdp.outbound.has_text", "false");

  var body = null;
  var rawContent = context.getVariable("response.content");
  try {
    body = rawContent ? JSON.parse(rawContent) : null;
  } catch (parseErr) {
    body = null;
  }

  var usage = (body && body.usageMetadata) || {};
  var logFields = {
    policyEnabled: outboundEnabled,
    sensitiveDataDetected: false,
    findingsCount: 0,
    modelVersion: (body && body.modelVersion) || null,
    promptTokens: usage.promptTokenCount || 0,
    candidatesTokens: usage.candidatesTokenCount || 0,
    totalTokens: usage.totalTokenCount || 0,
    targetLatencyMs: (context.getVariable("target.received.end.timestamp") || 0) -
      (context.getVariable("target.sent.start.timestamp") || 0)
  };
  context.setVariable("sdp.outbound.log.fields", JSON.stringify(logFields));

  if (!outboundEnabled) {
    context.setVariable("sdp.outbound.findings.types", "DISABLED_BY_POLICY");
    logFields.findingTypes = "DISABLED_BY_POLICY";
    logFields.partsInspected = 0;
    logFields.status = "BYPASSED_BY_POLICY";
    context.setVariable("sdp.outbound.log", SDP.buildLogEntry(sdpLogBase("outbound"), logFields));
  } else if (!body) {
    throw new Error("Model response is not valid JSON and cannot be inspected");
  } else {
    var refs = SDP.collectResponseParts(body);
    context.setVariable("sdp.outbound.findings.types", "NONE");
    if (refs.length === 0) {
      logFields.findingTypes = "NONE";
      logFields.partsInspected = 0;
      logFields.status = "NO_TEXT_RETURNED";
      context.setVariable("sdp.outbound.log", SDP.buildLogEntry(sdpLogBase("outbound"), logFields));
    } else {
      context.setVariable("sdp.outbound.has_text", "true");
      context.setVariable("sdp.outbound.parts.refs", JSON.stringify(refs));
      var payload = SDP.buildDeidentifyPayload(
        SDP.readTexts(body, refs),
        sdpProp("inspect_template"),
        sdpProp("deidentify_template"));
      context.setVariable("sdp.outbound.deidentify.payload", JSON.stringify(payload));
    }
  }
} catch (e) {
  sdpFail("prepare_outbound", e);
}
