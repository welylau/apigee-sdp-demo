/*
 * SDP-Apply-Outbound.js
 * Validates the DLP deidentify response (fail closed) and writes each sanitized
 * row back into its original response part. Emits the outbound audit log entry.
 */
try {
  var refs = JSON.parse(context.getVariable("sdp.outbound.parts.refs"));
  var result = SDP.parseDeidentifyResponse(
    context.getVariable("sdpDeidentifyOutboundResponse.status.code"),
    context.getVariable("sdpDeidentifyOutboundResponse.content"),
    refs.length);

  var body = JSON.parse(context.getVariable("response.content"));
  SDP.writeTexts(body, refs, result.texts);
  context.setVariable("response.content", JSON.stringify(body));
  context.setVariable("sdp.t.out_end", String(Date.now()));

  var detected = result.count > 0;
  context.setVariable("sdp.outbound.findings.detected", detected ? "true" : "false");
  context.setVariable("sdp.outbound.findings.count", String(result.count));
  context.setVariable("sdp.outbound.findings.types", detected ? result.types.join(", ") : "NONE");

  var logFields = JSON.parse(context.getVariable("sdp.outbound.log.fields") || "{}");
  logFields.sensitiveDataDetected = detected;
  logFields.findingsCount = result.count;
  logFields.findingTypes = detected ? result.types.join(", ") : "NONE";
  logFields.partsInspected = refs.length;
  logFields.deidentifiedText = detected ? result.texts.join("\n") : "";
  logFields.status = detected ? "DEIDENTIFIED_AND_RETURNED" : "CLEAN_RETURNED";
  context.setVariable("sdp.outbound.log", SDP.buildLogEntry(sdpLogBase("outbound"), logFields));
} catch (e) {
  sdpFail("apply_outbound", e);
}
