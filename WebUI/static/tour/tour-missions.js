/**
 * Guided Tour - mission definitions for Apigee X + Sensitive Data Protection.
 *
 * Purely declarative: tour-engine.js renders and sequences these. A mission is complete when its
 * last step completes; then the "What just happened?" explainer is shown.
 *
 * SDP masks rather than blocks, so a protected request is still HTTP 200 (verdict 'allowed').
 * Steps therefore complete on the SDP details app.js adds to demo:runresult:
 *   detail.sdp = { inbound: {enabled, count, types[]}, outbound: {enabled, count, types[]} }
 *   detail.mode = 'single' | 'compare'
 *
 * Step / mission schema: references/tour.md in the apigee-demo-ui skill.
 */

const click = (sel) => document.querySelector(sel)?.click();
const inCount = (d) => d?.sdp?.inbound?.count || 0;
const outCount = (d) => d?.sdp?.outbound?.count || 0;
const inTypes = (d) => d?.sdp?.inbound?.types || [];
const outTypes = (d) => d?.sdp?.outbound?.types || [];
const fail = (d) => (d.verdict === 'blocked' ? 'Blocked' : 'Error');
const errorHint = (d) => (d.ok ? '' : `Got <b>${fail(d)}</b>. Check that the gateway is deployed and <code>WebUI/.env</code> has the API key.`);

export const WELCOME = {
  icon: '🛡️',
  title: 'Welcome to Sensitive Data Protection on Apigee X',
  subtitle: 'Gemini 3.5 Flash-Lite · bidirectional PII governance at the gateway',
  minutes: 5,
  bullets: [
    'How every prompt flows through Apigee X and SDP',
    'A clean prompt passes with zero false positives',
    'Names, NRICs and cards are masked before Gemini sees them',
    'Outbound SDP catches PII the model rebuilds',
    'Switching SDP off is a privilege, and every decision is audited',
  ],
};

export const FINISH = {
  lead: "You've seen Apigee X with Sensitive Data Protection:",
  bullets: [
    'Inspect every text part of a prompt at the gateway, with no app changes',
    'Keep the task working on masked data (infoType tokens)',
    'Catch PII the model generates or reassembles on the way out',
    'Fail closed, gate bypasses per app, and audit everything in Cloud Logging',
  ],
};

export const MISSIONS = [
  // ---------------------------------------------------------------- 1
  {
    id: 'architecture', title: 'Meet the architecture', badge: 'Overview',
    steps: [{
      kind: 'action', title: 'Meet the architecture', target: '#viewArchBtn',
      body: `This page calls a small server that holds the API key. It forwards your prompt to the
        <b>Apigee X</b> proxy, which sends every text part to <b>Sensitive Data Protection</b>
        before and after <b>Gemini</b>.<ul><li>Keys never reach the browser</li><li>Policies run at the gateway, not in the app</li></ul>`,
      action: { label: 'Open the diagram', run: () => click('#viewArchBtn') },
      done: { click: '#viewArchBtn' },
    }],
    explainer: {
      title: 'The request path',
      flow: [
        { text: 'Apigee verifies the API key, spike arrest and LLM token quota', state: 'ok', tag: 'PreFlow' },
        { text: 'Inbound SDP de-identifies the system instruction and every turn', state: 'ok', tag: 'SDP ①' },
        { text: 'Only sanitized text reaches Gemini on Vertex AI', state: 'ok', tag: 'Vertex AI' },
        { text: 'Outbound SDP inspects the model answer before it returns', state: 'ok', tag: 'SDP ②' },
        { text: 'A sanitized audit entry goes to Cloud Logging', state: 'ok', tag: 'Audit' },
      ],
      note: 'Close the diagram with <kbd>Esc</kbd> when you are ready.',
    },
  },
  // ---------------------------------------------------------------- 2
  {
    id: 'baseline', title: 'Zero false positives', badge: 'Clean',
    steps: [{
      kind: 'scenario', scenario: 'clean-api', title: 'Send a clean prompt',
      body: 'Nothing sensitive in this prompt, so SDP should change <b>nothing</b>. Watch the pipeline to see how little latency SDP adds.',
      expect: 'HTTP 200 · inbound and outbound clean',
      done: { run: (d) => d.ok && inCount(d) === 0 },
      onMiss: (d) => errorHint(d) || 'SDP reported a finding. Check the inspect template in <code>dlp/</code>.',
    }],
    explainer: (e) => ({
      title: 'Clean in, clean out',
      flow: [
        { text: 'API key, spike arrest and token quota passed', state: 'ok', tag: 'Apigee' },
        { text: 'Inbound SDP: 0 findings, prompt forwarded unchanged', state: 'ok', tag: 'SDP ①' },
        { text: `Gemini answered${e.lastRun?.tokens?.total ? ` using ${e.lastRun.tokens.total.toLocaleString()} tokens` : ''}`, state: 'ok', tag: '200' },
        { text: `Outbound SDP: ${outCount(e.lastRun)} findings`, state: 'ok', tag: 'SDP ②' },
      ],
      note: 'The latency bar under the pipeline shows SDP’s share of the end-to-end time.',
    }),
  },
  // ---------------------------------------------------------------- 3
  {
    id: 'inbound-mask', title: 'Mask PII before Gemini sees it', badge: 'Masked',
    steps: [{
      kind: 'scenario', scenario: 'bank-refund', title: 'Send a refund request with PII',
      body: 'A name, NRIC, Visa card and email. Apigee replaces each one with an infoType token such as <code>[CREDIT_CARD_NUMBER]</code>.',
      expect: 'HTTP 200 · 4 values masked inbound',
      done: { run: (d) => d.ok && inCount(d) >= 3 },
      onMiss: (d) => errorHint(d) || `Only ${inCount(d)} finding(s). Is <code>sdp-inbound</code> on?`,
    }, {
      kind: 'action', title: 'What Gemini actually saw', target: '.xray-grid', shade: false,
      body: 'Column ① is what you typed (red = removed). Column ② is the exact text Gemini received. The bank-assistant persona still completes the refund using the tokens.',
      action: { label: 'Got it', run: (e) => e.completeStep() },
    }, {
      kind: 'scenario', scenario: 'identity-bare', title: 'A bare NRIC, no keyword',
      body: 'The built-in detector needs context like “NRIC”. A <b>custom</b> <code>SG_NRIC_FIN</code> pattern in the inspect template catches IDs typed without it.',
      expect: 'Masked as SG_NRIC_FIN',
      done: { run: (d) => d.ok && inCount(d) >= 1 },
      onMiss: (d) => errorHint(d) || 'Nothing was masked. Is the v2 inspect template (custom infoTypes) deployed?',
    }],
    explainer: (e) => ({
      title: 'De-identified at the gateway',
      flow: [
        { text: 'Every text part sent to SDP in one content:deidentify call', state: 'ok', tag: 'ServiceCallout' },
        { text: `Detected: ${inTypes(e.lastRun).join(', ') || '—'}`, state: 'ok', tag: 'Findings' },
        { text: 'Raw values replaced with infoType tokens; fails closed on error', state: 'ok', tag: 'JS-Apply' },
        { text: 'Gemini never received the original values', state: 'skip', tag: 'Vertex AI' },
      ],
      note: 'Custom detectors (<code>SG_NRIC_FIN</code>, <code>SG_BANK_ACCOUNT</code>) sit next to the built-in infoTypes in the same template.',
    }),
  },
  // ---------------------------------------------------------------- 4
  {
    id: 'outbound', title: 'Catch what the model rebuilds', badge: 'Outbound',
    steps: [{
      kind: 'scenario', scenario: 'outbound-reassemble', title: 'Smuggle PII in as fragments',
      body: 'The card number and NRIC arrive as harmless-looking pieces, so inbound SDP has nothing to mask. Gemini stitches them back together…',
      expect: 'Outbound SDP masks the rebuilt values',
      done: { run: (d) => d.ok && outCount(d) >= 1 },
      onMiss: (d) => errorHint(d) || 'The model did not rebuild the values this time. Run it again.',
    }, {
      kind: 'action', title: 'Read the result', target: '#metricsBar', shade: false,
      body: '<b>Inbound PII</b> is clean, <b>Outbound PII</b> is not. Red tokens in the response are the values outbound SDP caught.',
      action: { label: 'Got it', run: (e) => e.completeStep() },
    }],
    explainer: (e) => ({
      title: 'Defence in both directions',
      flow: [
        { text: `Inbound SDP: ${inCount(e.lastRun)} findings (fragments look harmless)`, state: 'miss', tag: 'SDP ①' },
        { text: 'Gemini reassembled the card number and NRIC', state: 'fail', tag: 'Vertex AI' },
        { text: `Outbound SDP caught: ${outTypes(e.lastRun).join(', ') || '—'}`, state: 'ok', tag: 'SDP ②' },
        { text: 'The client only received tokens', state: 'ok', tag: '200' },
      ],
      handoff: { missed: 'Inbound SDP', caught: 'Outbound SDP', text: 'What one direction misses, the other catches.' },
    }),
  },
  // ---------------------------------------------------------------- 5
  {
    id: 'governance', title: 'Bypass is a privilege', badge: 'Compare',
    steps: [{
      kind: 'action', title: 'Same prompt, SDP off vs on', target: '#compareBtn',
      before: (e) => e.app.loadScenario('bank-refund'),
      body: 'Compare sends the refund prompt twice: once with SDP <b>off</b>, once <b>on</b>. Only this demo app may switch SDP off (<code>sdp_bypass_allowed=true</code>).',
      expect: 'Red pane leaks raw values · green pane shows tokens',
      action: { label: 'Run compare', run: (e) => e.app.compare() },
      done: { run: (d) => d.mode === 'compare' },
      onMiss: (d) => errorHint(d),
    }, {
      kind: 'action', title: 'Who may switch SDP off?', target: '.policy-bar', shade: false,
      body: 'The proxy reads the <code>sdp_bypass_allowed</code> attribute on the calling app. Any other app that asks for SDP off gets <b>HTTP 403</b>, and every bypass is written to Cloud Logging.',
      action: { label: 'Got it', run: (e) => e.completeStep() },
    }],
    explainer: {
      title: 'Governed, not optional',
      flow: [
        { text: 'SDP OFF: Gemini and the client saw the raw values', state: 'fail', tag: 'Bypass' },
        { text: 'SDP ON: only infoType tokens left the gateway', state: 'ok', tag: 'Protected' },
        { text: 'Bypass honoured only for apps with sdp_bypass_allowed=true', state: 'ok', tag: 'App attribute' },
        { text: 'Everyone else: HTTP 403 (RF-SDP-Bypass-Forbidden)', state: 'ok', tag: '403' },
      ],
    },
  },
  // ---------------------------------------------------------------- 6
  {
    id: 'audit', title: 'Proof in Cloud Logging', badge: 'Audit',
    steps: [{
      kind: 'action', title: 'Every decision is audited', target: '#adminTab',
      body: 'The tab on the right edge opens the security audit drawer: sanitized entries from Cloud Logging, KPIs and infoType charts. It is a real <code>&lt;button&gt;</code>, so <kbd>Tab</kbd> + <kbd>Enter</kbd> works too.',
      action: { label: 'Open audit log', run: () => click('#adminTab') },
      done: { click: '#adminTab, #btnOpenAdmin, #btnOpenAdminFromLeft' },
    }],
    explainer: {
      title: 'The audit trail',
      flow: [
        { text: 'One inbound and one outbound entry per request', state: 'ok', tag: 'MessageLogging' },
        { text: 'Findings, infoTypes, status (clean, masked, bypassed, blocked)', state: 'ok', tag: 'Ledger' },
        { text: 'Only sanitized text is stored, never the raw values', state: 'ok', tag: 'Privacy' },
      ],
      note: 'Entries take 5–30 s to appear in Cloud Logging. Use <b>Sync Cloud Logging</b> to refresh.',
    },
  },
];
