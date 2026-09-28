/*
 * SDP-Finalize-Response.js
 *  1. Computes per-stage latency and exposes it as X-SDP-Timing (always; no content).
 *  2. When the caller asked for x-sdp-debug AND its app has sdp_debug_allowed=true,
 *     attaches an "sdpAudit" object to the JSON response containing ONLY sanitized
 *     inbound parts (what the model actually received) plus findings and timing.
 *     Raw prompt text and raw model output are never returned.
 * Runs with continueOnError=true: it must never break an otherwise good response.
 */
var timing = SDP.buildTiming({
  clientStart: context.getVariable("client.received.start.timestamp"),
  inStart: context.getVariable("sdp.t.in_start"),
  inEnd: context.getVariable("sdp.t.in_end"),
  targetSent: context.getVariable("target.sent.start.timestamp"),
  targetReceived: context.getVariable("target.received.end.timestamp"),
  outStart: context.getVariable("sdp.t.out_start"),
  outEnd: context.getVariable("sdp.t.out_end"),
  now: Date.now()
});
context.setVariable("sdp.timing", SDP.formatTiming(timing));

if (context.getVariable("sdp.debug.status") === "enabled") {
  var body = null;
  try {
    body = JSON.parse(context.getVariable("response.content"));
  } catch (e) {
    body = null;
  }
  if (body && typeof body === "object") {
    var inboundEnabled = context.getVariable("sdp.inbound.enabled") === "true";
    var parts = context.getVariable("sdp.inbound.sanitized.parts");
    body.sdpAudit = {
      requestId: context.getVariable("messageid"),
      inbound: {
        policyEnabled: inboundEnabled,
        // null when inbound SDP was bypassed: the gateway never echoes unverified text.
        modelSawParts: inboundEnabled && parts ? JSON.parse(parts) : null,
        findingsCount: parseInt(context.getVariable("sdp.inbound.findings.count") || "0", 10),
        findingTypes: context.getVariable("sdp.inbound.findings.types") || "NONE"
      },
      outbound: {
        policyEnabled: context.getVariable("sdp.outbound.enabled") === "true",
        findingsCount: parseInt(context.getVariable("sdp.outbound.findings.count") || "0", 10),
        findingTypes: context.getVariable("sdp.outbound.findings.types") || "NONE"
      },
      templates: {
        inspect: sdpProp("inspect_template"),
        deidentify: sdpProp("deidentify_template")
      },
      model: sdpProp("model"),
      timingMs: timing
    };
    context.setVariable("response.content", JSON.stringify(body));
  }
}
