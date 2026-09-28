/*
 * SDP-Apply-Inbound.js
 * Validates the DLP deidentify response (fail closed) and writes each sanitized
 * row back into its original request part. Emits the inbound audit log entry.
 */
try {
  var refs = JSON.parse(context.getVariable("sdp.inbound.parts.refs"));
  var result = SDP.parseDeidentifyResponse(
    context.getVariable("sdpDeidentifyInboundResponse.status.code"),
    context.getVariable("sdpDeidentifyInboundResponse.content"),
    refs.length);

  var body = JSON.parse(context.getVariable("request.content"));
  SDP.writeTexts(body, refs, result.texts);
  context.setVariable("request.content", JSON.stringify(body));
  context.setVariable("sdp.t.in_end", String(Date.now()));

  // X-ray: only sanitized text is kept, and only for debug-enabled apps.
  if (context.getVariable("sdp.debug.status") === "enabled") {
    context.setVariable("sdp.inbound.sanitized.parts",
      JSON.stringify(SDP.describeParts(body, refs, result.texts)));
  }

  var detected = result.count > 0;
  context.setVariable("sdp.inbound.findings.detected", detected ? "true" : "false");
  context.setVariable("sdp.inbound.findings.count", String(result.count));
  context.setVariable("sdp.inbound.findings.types", detected ? result.types.join(", ") : "NONE");

  context.setVariable("sdp.inbound.log", SDP.buildLogEntry(sdpLogBase("inbound"), {
    policyEnabled: true,
    sensitiveDataDetected: detected,
    findingsCount: result.count,
    findingTypes: detected ? result.types.join(", ") : "NONE",
    partsInspected: refs.length,
    // Only sanitized text is ever logged, and only when something was masked.
    deidentifiedText: detected ? result.texts.join("\n") : "",
    status: detected ? "DEIDENTIFIED_AND_FORWARDED" : "CLEAN_FORWARDED"
  }));
} catch (e) {
  sdpFail("apply_inbound", e);
}
