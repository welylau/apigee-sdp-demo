/*
 * sdp-common.js — shared helpers for Sensitive Data Protection (SDP) processing.
 *
 * Included by the SDP JavaScript policies via <IncludeURL>. Written in ES5 for the
 * Apigee JavaScript runtime. Pure helpers take explicit arguments (no `context`
 * access) so they can be unit tested outside Apigee.
 *
 * Design principles:
 *   - Every text part is de-identified individually (DLP table item, one row per
 *     part) and written back to exactly the same location.
 *   - Fail closed: any unexpected DLP result raises an error instead of falling
 *     back to the original text.
 */
var SDP = (function () {
  var OFF_VALUES = ["false", "0", "no", "off"];

  function isBlank(v) {
    return v === null || v === undefined || String(v).trim() === "";
  }

  /** Returns true when a toggle value explicitly asks to switch SDP off. */
  function isOff(v) {
    return !isBlank(v) && OFF_VALUES.indexOf(String(v).toLowerCase().trim()) !== -1;
  }

  /** Returns the first non-blank value from the argument list, or null. */
  function firstNonBlank() {
    for (var i = 0; i < arguments.length; i++) {
      if (!isBlank(arguments[i])) {
        return arguments[i];
      }
    }
    return null;
  }

  function pushTextParts(refs, parts, basePath) {
    for (var j = 0; j < parts.length; j++) {
      var p = parts[j];
      if (p && typeof p.text === "string" && p.text.length > 0) {
        refs.push(basePath.concat([j]));
      }
    }
  }

  /**
   * Collects paths to every text part in a Gemini generateContent request:
   * systemInstruction.parts[*] and contents[*].parts[*].
   */
  function collectRequestParts(body) {
    var refs = [];
    if (!body || typeof body !== "object") {
      return refs;
    }
    if (body.systemInstruction && Array.isArray(body.systemInstruction.parts)) {
      pushTextParts(refs, body.systemInstruction.parts, ["systemInstruction", "parts"]);
    }
    if (Array.isArray(body.contents)) {
      for (var i = 0; i < body.contents.length; i++) {
        var turn = body.contents[i];
        if (turn && Array.isArray(turn.parts)) {
          pushTextParts(refs, turn.parts, ["contents", i, "parts"]);
        }
      }
    }
    return refs;
  }

  /** Collects paths to every text part across ALL candidates of a Gemini response. */
  function collectResponseParts(body) {
    var refs = [];
    if (!body || !Array.isArray(body.candidates)) {
      return refs;
    }
    for (var c = 0; c < body.candidates.length; c++) {
      var cand = body.candidates[c];
      if (cand && cand.content && Array.isArray(cand.content.parts)) {
        pushTextParts(refs, cand.content.parts, ["candidates", c, "content", "parts"]);
      }
    }
    return refs;
  }

  function getAt(obj, path) {
    var cur = obj;
    for (var i = 0; i < path.length; i++) {
      if (cur === null || cur === undefined) {
        return undefined;
      }
      cur = cur[path[i]];
    }
    return cur;
  }

  function readTexts(body, refs) {
    var texts = [];
    for (var i = 0; i < refs.length; i++) {
      texts.push(getAt(body, refs[i]).text);
    }
    return texts;
  }

  function writeTexts(body, refs, texts) {
    if (refs.length !== texts.length) {
      throw new Error("Part count mismatch: " + refs.length + " parts vs " + texts.length + " texts");
    }
    for (var i = 0; i < refs.length; i++) {
      var part = getAt(body, refs[i]);
      if (!part) {
        throw new Error("Part path no longer exists: " + refs[i].join("."));
      }
      part.text = texts[i];
    }
  }

  /** Builds a DLP content:deidentify request with one table row per text part. */
  function buildDeidentifyPayload(texts, inspectTemplate, deidentifyTemplate) {
    var rows = [];
    for (var i = 0; i < texts.length; i++) {
      rows.push({ values: [{ stringValue: texts[i] }] });
    }
    return {
      inspectTemplateName: inspectTemplate,
      deidentifyTemplateName: deidentifyTemplate,
      item: { table: { headers: [{ name: "text" }], rows: rows } }
    };
  }

  /**
   * Parses a DLP content:deidentify response. Throws (fail closed) if the response
   * is missing, malformed, has the wrong number of rows, or reports a
   * transformation error.
   * Returns { texts: [...], count: <int>, types: [...] }.
   */
  function parseDeidentifyResponse(statusCode, content, expectedRows) {
    if (String(statusCode) !== "200") {
      throw new Error("DLP deidentify returned HTTP " + (statusCode || "no response"));
    }
    var res = JSON.parse(content);
    var rows = res && res.item && res.item.table && res.item.table.rows;
    if (!Array.isArray(rows) || rows.length !== expectedRows) {
      throw new Error("DLP returned " + (Array.isArray(rows) ? rows.length : 0) +
        " rows, expected " + expectedRows);
    }
    var texts = [];
    for (var i = 0; i < rows.length; i++) {
      var v = rows[i] && rows[i].values && rows[i].values[0];
      if (!v || typeof v.stringValue !== "string") {
        throw new Error("DLP row " + i + " has no stringValue");
      }
      texts.push(v.stringValue);
    }

    var count = 0;
    var types = [];
    var summaries = (res.overview && res.overview.transformationSummaries) || [];
    for (var s = 0; s < summaries.length; s++) {
      var summary = summaries[s];
      var results = summary.results || [];
      var n = 0;
      for (var r = 0; r < results.length; r++) {
        if (results[r].code && results[r].code !== "SUCCESS") {
          throw new Error("DLP transformation error for " +
            ((summary.infoType && summary.infoType.name) || "unknown infoType"));
        }
        n += parseInt(results[r].count || "0", 10);
      }
      if (n > 0) {
        count += n;
        var name = summary.infoType && summary.infoType.name;
        if (name && types.indexOf(name) === -1) {
          types.push(name);
        }
      }
    }
    return { texts: texts, count: count, types: types };
  }

  /** Returns the conversational role of a request part path: "system", "user" or "model". */
  function partRole(body, ref) {
    if (ref[0] === "systemInstruction") {
      return "system";
    }
    var turn = body && Array.isArray(body.contents) ? body.contents[ref[1]] : null;
    return (turn && turn.role) || "user";
  }

  /** Pairs each (already sanitized) text with its role, for the x-sdp-debug X-ray view. */
  function describeParts(body, refs, texts) {
    var out = [];
    for (var i = 0; i < refs.length; i++) {
      out.push({ role: partRole(body, refs[i]), text: texts[i] });
    }
    return out;
  }

  function span(start, end) {
    var s = Number(start), e = Number(end);
    return s > 0 && e >= s ? e - s : 0;
  }

  /**
   * Computes per-stage latency in ms from epoch-ms timestamps:
   *   gateway = client received -> inbound SDP start (API key, spike arrest, token quota)
   *   dlp_in  = inbound SDP start -> end
   *   model   = target sent -> target received
   *   dlp_out = outbound SDP start -> end
   *   total   = client received -> now
   */
  function buildTiming(t) {
    return {
      gateway: span(t.clientStart, t.inStart),
      dlp_in: span(t.inStart, t.inEnd),
      model: span(t.targetSent, t.targetReceived),
      dlp_out: span(t.outStart, t.outEnd),
      total: span(t.clientStart, t.now)
    };
  }

  /** Serialises a timing object as an X-SDP-Timing header value, e.g. "gateway=4;dlp_in=180". */
  function formatTiming(timing) {
    var keys = ["gateway", "dlp_in", "model", "dlp_out", "total"];
    var parts = [];
    for (var i = 0; i < keys.length; i++) {
      parts.push(keys[i] + "=" + (timing[keys[i]] || 0));
    }
    return parts.join(";");
  }

  /** Builds a structured audit log entry (never contains raw, un-sanitized text). */
  function buildLogEntry(base, fields) {
    var entry = {};
    var k;
    for (k in base) {
      if (base.hasOwnProperty(k)) {
        entry[k] = base[k];
      }
    }
    for (k in fields) {
      if (fields.hasOwnProperty(k)) {
        entry[k] = fields[k];
      }
    }
    return JSON.stringify(entry);
  }

  return {
    isBlank: isBlank,
    isOff: isOff,
    firstNonBlank: firstNonBlank,
    collectRequestParts: collectRequestParts,
    collectResponseParts: collectResponseParts,
    readTexts: readTexts,
    writeTexts: writeTexts,
    buildDeidentifyPayload: buildDeidentifyPayload,
    parseDeidentifyResponse: parseDeidentifyResponse,
    partRole: partRole,
    describeParts: describeParts,
    buildTiming: buildTiming,
    formatTiming: formatTiming,
    buildLogEntry: buildLogEntry
  };
})();

/* Context-aware helpers (only used inside Apigee). */
function sdpProp(name) {
  return context.getVariable("propertyset.sdp." + name);
}

function sdpFail(stage, err) {
  context.setVariable("sdp.error", "true");
  context.setVariable("sdp.error.stage", stage);
  context.setVariable("sdp.error.detail", String((err && err.message) || err));
}

function sdpLogBase(direction) {
  return {
    proxy: context.getVariable("apiproxy.name"),
    direction: direction,
    organization: context.getVariable("organization.name"),
    environment: context.getVariable("environment.name"),
    requestId: context.getVariable("messageid"),
    clientIp: context.getVariable("client.ip"),
    app: context.getVariable("verifyapikey.VA-Verify-API-Key.app.name"),
    timestamp: new Date().toISOString()
  };
}
