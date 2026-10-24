/**
 * Apigee X + Sensitive Data Protection (Cloud DLP) Demonstration Client
 * House style: apigee-demo-ui (vanilla JS, DOM APIs only, no innerHTML).
 *
 * Views:
 *   - Pipeline: live request path with real per-stage latency (X-SDP-Timing header)
 *   - SDP X-ray: what you typed -> what Gemini saw (sanitized, from the gateway) -> outbound SDP
 *   - Compare: the same prompt with SDP OFF vs ON (demo app only: sdp_bypass_allowed=true)
 *
 * Integration contract (used by tour/tour-engine.js; this file never depends on tour/):
 *   window.demoApp             facade (see bottom of file)
 *   window 'demo:ready'        facade available
 *   window 'demo:configloaded' /api/config applied
 *   window 'demo:runresult'    detail = { ok, httpStatus, latencyMs, tokens, verdict, response,
 *                                         requestHeaders, responseHeaders, scenarioId, mode, sdp }
 *   window 'demo:themechange'  detail { theme }
 *   window 'demo:archopen'
 * Scenario chips carry data-scenario="<id>". Run button #runBtn, result card #resultCard.
 */

const DEMO_SLUG = "apigee-sdp-demo";
const storageKey = (k) => `${DEMO_SLUG}.${k}`;
const store = {
    get(k) { try { return localStorage.getItem(storageKey(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(storageKey(k), String(v)); } catch (e) { /* storage unavailable */ } }
};

// Theme is applied before first paint (this script is loaded in <head>).
(function applySavedTheme() {
    let saved = store.get("theme");
    if (!saved) {
        try { saved = localStorage.getItem("apigee_sdp_theme"); } catch (e) { saved = null; } // legacy key
        if (saved) store.set("theme", saved);
    }
    document.documentElement.setAttribute("data-theme", saved === "dark" ? "dark" : "light");
})();

document.addEventListener("DOMContentLoaded", () => {
    // --- State ---
    let currentLogs = [];
    let selectedTimeHours = 24;
    let busy = false;
    let pipelineTimer = null;
    let activePreset = null;
    let lastResult = null;
    let archOpener = null;
    let adminOpener = null;
    let logOpener = null;
    let config = {
        proxyUrl: "https://YOUR_APIGEE_IP.nip.io/gemini-sdp-proxy",
        project: "YOUR_GCP_PROJECT_ID",
        logName: "projects/YOUR_GCP_PROJECT_ID/logs/apigee-sdp-logs",
        logId: "apigee-sdp-logs",
        model: "gemini-3.5-flash-lite",
        inspectTemplate: "inspect-sensitive-v2",
        deidentifyTemplate: "deidentify-sensitive-v2",
        maxPromptChars: 2000
    };

    const $ = (id) => document.getElementById(id);
    const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));

    // =========================================================================
    // 0. DOM helpers (no innerHTML anywhere in this file)
    // =========================================================================
    function flatKids(kids) {
        return kids.flat(Infinity)
            .filter(k => k !== null && k !== undefined && k !== false)
            .map(k => (k instanceof Node ? k : document.createTextNode(String(k))));
    }

    /** h("span", {class, text, style, title, "data-x": ..., onClick}, ...children) */
    function h(tag, props, ...kids) {
        const node = document.createElement(tag);
        Object.entries(props || {}).forEach(([k, v]) => {
            if (v === null || v === undefined || v === false) return;
            if (k === "class") node.className = v;
            else if (k === "text") node.textContent = String(v);
            else if (k === "style") node.style.cssText = v;
            else if (k === "onClick") node.addEventListener("click", v);
            else node.setAttribute(k, String(v));
        });
        node.append(...flatKids(kids));
        return node;
    }

    const fill = (node, ...kids) => { if (node) node.replaceChildren(...flatKids(kids)); };
    const note = (text, cls = "xray-empty") => h("span", { class: cls }, text);

    // Friendly names for DLP infoTypes (legend + token tooltips).
    const INFO_TYPE_LABELS = {
        SINGAPORE_NATIONAL_REGISTRATION_ID_NUMBER: "SG NRIC / FIN",
        SG_NRIC_FIN: "SG NRIC / FIN (pattern)",
        SINGAPORE_PASSPORT: "SG passport",
        PASSPORT: "Passport",
        GOVERNMENT_ID: "Government ID",
        CREDIT_CARD_NUMBER: "Card number",
        CREDIT_CARD_DATA: "Card data (CVV / expiry)",
        CREDIT_CARD_TRACK_NUMBER: "Card track data",
        IBAN_CODE: "IBAN",
        SWIFT_CODE: "SWIFT / BIC",
        SG_BANK_ACCOUNT: "SG bank account",
        PERSON_NAME: "Person name",
        EMAIL_ADDRESS: "Email address",
        PHONE_NUMBER: "Phone number",
        STREET_ADDRESS: "Street address",
        DATE_OF_BIRTH: "Date of birth",
        GCP_API_KEY: "Google API key",
        GCP_CREDENTIALS: "GCP credentials",
        AUTH_TOKEN: "Auth token",
        PASSWORD: "Password"
    };
    const labelFor = (t) => INFO_TYPE_LABELS[t] || t.replace(/_/g, " ").toLowerCase();

    // Assistant personas (sent as systemInstruction; SDP inspects it too).
    const TOKEN_RULE = "Values in square brackets such as [CREDIT_CARD_NUMBER] or [PERSON_NAME] are secure references " +
        "to data redacted by the gateway. Treat them as valid, keep them exactly as written, and never ask for the real values.";
    const PERSONAS = {
        bank: { label: "Retail bank support assistant",
            text: "You are a retail banking support assistant for a Singapore bank. " + TOKEN_RULE + " Complete the task concisely." },
        clinic: { label: "Clinic documentation assistant",
            text: "You are a clinical documentation assistant at a Singapore clinic. " + TOKEN_RULE + " Be concise and professional." },
        hr: { label: "HR operations assistant",
            text: "You are an HR operations assistant. " + TOKEN_RULE + " Keep documents short and professional." }
    };

    // Theme elements
    const themeToggleBtn = $("themeToggleBtn");
    const themeIconSun = $("themeIconSun");
    const themeIconMoon = $("themeIconMoon");

    // Layout elements
    const splitter = $("splitter");
    const leftPanel = $("leftPanel");
    const workspaceLayout = document.querySelector(".workspace-layout");

    // Policy & preset elements
    const toggleInboundPolicy = $("toggleInboundPolicy");
    const toggleOutboundPolicy = $("toggleOutboundPolicy");
    const switchInbound = $("switchInbound");
    const switchOutbound = $("switchOutbound");
    const policyModeBadge = $("policyModeBadge");
    const scenarioCallout = $("scenarioCallout");
    const scenarioCalloutTitle = $("scenarioCalloutTitle");
    const scenarioCalloutDesc = $("scenarioCalloutDesc");
    const scenarioCalloutIcon = $("scenarioCalloutIcon");
    const scenarioExpect = $("scenarioExpect");

    // Prompt & execution elements
    const promptInput = $("promptInput");
    const systemInput = $("systemInput");
    const systemBadge = $("systemBadge");
    const charBadge = $("charBadge");
    const clearBtn = $("clearBtn");
    const runBtn = $("runBtn");
    const compareBtn = $("compareBtn");
    const btnSpinner = $("btnSpinner");
    const btnOpenAdminFromLeft = $("btnOpenAdminFromLeft");

    // Result card elements
    const statusPill = $("statusPill");
    const metricLatency = $("metricLatency");
    const metricInboundPII = $("metricInboundPII");
    const metricOutboundPII = $("metricOutboundPII");
    const metricTokens = $("metricTokens");
    const pipeline = $("pipeline");
    const latencyBar = $("latencyBar");

    const securityBanner = $("securityBanner");
    const bannerIcon = $("bannerIcon");
    const bannerTitle = $("bannerTitle");
    const bannerDesc = $("bannerDesc");

    const tokenLeakIndicator = $("tokenLeakIndicator");
    const modelOutputBox = $("modelOutputBox");

    const auditStatusBadge = $("auditStatusBadge");
    const xrayTyped = $("xrayTyped");
    const xraySaw = $("xraySaw");
    const xrayOut = $("xrayOut");
    const xrayLegend = $("xrayLegend");
    const selfTest = $("selfTest");
    const logsLink = $("logsLink");

    const telemetryBadge = $("telemetryBadge");
    const rawHeadersBox = $("rawHeadersBox");

    // Compare elements
    const compareCard = $("compareCard");

    // Admin Drawer elements
    const btnOpenAdmin = $("btnOpenAdmin");
    const adminTab = $("adminTab");
    const adminDrawer = $("adminDrawer");
    const adminDrawerBackdrop = $("adminDrawerBackdrop");
    const btnCloseAdminDrawer = $("btnCloseAdminDrawer");
    const btnRefreshAdmin = $("btnRefreshAdmin");
    const adminDirectionSelect = $("adminDirectionSelect");
    const adminTableSearch = $("adminTableSearch");
    const adminTableBody = $("adminTableBody");
    const tableRecordCount = $("tableRecordCount");

    // KPI elements
    const kpiTotalScans = $("kpiTotalScans");
    const kpiInboundDetected = $("kpiInboundDetected");
    const kpiOutboundDetected = $("kpiOutboundDetected");
    const kpiTotalDeidentified = $("kpiTotalDeidentified");

    // Charts containers
    const trafficChartContainer = $("trafficChartContainer");
    const infoTypeChartContainer = $("infoTypeChartContainer");

    // Modals
    const archModal = $("archModal");
    const viewArchBtn = $("viewArchBtn");
    const archModalCloseBtn = $("archModalCloseBtn");

    const logDetailModal = $("logDetailModal");
    const modalCloseBtn = $("modalCloseBtn");
    const btnCloseModalBottom = $("btnCloseModalBottom");
    const btnCopyModalJson = $("btnCopyModalJson");
    const modalMetaGrid = $("modalMetaGrid");
    const modalLogJson = $("modalLogJson");
    const modalLogsLink = $("modalLogsLink");

    // =========================================================================
    // 1. Utilities: toasts, config, Cloud Logging links
    // =========================================================================
    function toast(message, kind = "info") {
        const container = $("toastContainer");
        if (!container) return;
        const el = h("div", { class: `toast toast-${kind}` }, message);
        container.appendChild(el);
        setTimeout(() => el.classList.add("toast-hide"), 3200);
        setTimeout(() => el.remove(), 3700);
    }

    function splitTypes(value) {
        if (!value || value === "NONE" || value === "DISABLED_BY_POLICY") return [];
        return String(value).split(",").map(t => t.trim()).filter(Boolean);
    }

    function logsExplorerUrl(requestId) {
        if (!requestId) return null;
        const query = `logName="${config.logName}"\njsonPayload.requestId="${requestId}"`;
        return `https://console.cloud.google.com/logs/query;query=${encodeURIComponent(query)}` +
            `?project=${encodeURIComponent(config.project)}`;
    }

    async function loadConfig() {
        try {
            const res = await fetch("/api/config");
            if (res.ok) config = Object.assign(config, await res.json());
        } catch (e) {
            console.warn("Using default config", e);
        }
        const prettyModel = config.model.replace(/^gemini-/, "Gemini ").replace(/-/g, " ")
            .replace(/\b(flash|lite|pro)\b/gi, w => w[0].toUpperCase() + w.slice(1));
        $("brandSubtitle").textContent = `${prettyModel} • Bidirectional Inbound & Outbound PII Governance`;
        $("pipeModelName").textContent = config.model.replace(/^gemini-/, "");
        $("endpointPath").textContent = `POST ${config.proxyUrl}`;
        if ($("headerLogId")) $("headerLogId").textContent = config.logId;
        $("adminLogBadge").textContent = config.logId;
        $("adminProjectBadge").textContent = config.project;
        $("archLogPath").textContent = config.logName;
        $("archModel").textContent = config.model;
        $("archTemplates").textContent = `${config.inspectTemplate} / ${config.deidentifyTemplate}`;
        if (config.apiKeyConfigured === false) {
            toast("APIGEE_API_KEY is not configured: run ./setup-apigee-resources.sh", "error");
        }
        emit("demo:configloaded", { apiKeyConfigured: config.apiKeyConfigured });
    }

    // =========================================================================
    // 2. Theme (light default; persisted as '<slug>.theme')
    // =========================================================================
    function applyTheme(theme) {
        const t = theme === "dark" ? "dark" : "light";
        document.documentElement.setAttribute("data-theme", t);
        if (themeIconSun && themeIconMoon) {
            themeIconSun.style.display = t === "dark" ? "none" : "block";
            themeIconMoon.style.display = t === "dark" ? "block" : "none";
        }
        return t;
    }

    function setTheme(theme) {
        const t = applyTheme(theme);
        store.set("theme", t);
        emit("demo:themechange", { theme: t });
    }

    function initTheme() {
        applyTheme(document.documentElement.getAttribute("data-theme"));
        if (themeToggleBtn) {
            themeToggleBtn.addEventListener("click", () => {
                const current = document.documentElement.getAttribute("data-theme") || "light";
                setTheme(current === "light" ? "dark" : "light");
            });
        }
    }

    // =========================================================================
    // 3. Resizable splitter (mouse + keyboard)
    // =========================================================================
    function initSplitter() {
        if (!splitter || !leftPanel || !workspaceLayout) return;
        const MIN = 340, MAX = 750;
        const clamp = (w) => Math.max(MIN, Math.min(MAX, w));

        splitter.setAttribute("role", "separator");
        splitter.setAttribute("aria-orientation", "vertical");
        splitter.setAttribute("aria-label", "Resize panels");
        splitter.tabIndex = 0;

        let isDragging = false;
        splitter.addEventListener("mousedown", (e) => {
            e.preventDefault();
            isDragging = true;
            splitter.classList.add("active");
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";

            function onMouseMove(moveEvent) {
                if (!isDragging) return;
                const rect = workspaceLayout.getBoundingClientRect();
                leftPanel.style.width = `${clamp(moveEvent.clientX - rect.left)}px`;
            }

            function onMouseUp() {
                if (!isDragging) return;
                isDragging = false;
                splitter.classList.remove("active");
                document.body.style.cursor = "";
                document.body.style.userSelect = "";
                window.removeEventListener("mousemove", onMouseMove);
                window.removeEventListener("mouseup", onMouseUp);
            }

            window.addEventListener("mousemove", onMouseMove);
            window.addEventListener("mouseup", onMouseUp);
        });

        splitter.addEventListener("keydown", (e) => {
            const width = leftPanel.getBoundingClientRect().width;
            if (e.key === "ArrowLeft") { e.preventDefault(); leftPanel.style.width = `${clamp(width - 24)}px`; }
            else if (e.key === "ArrowRight") { e.preventDefault(); leftPanel.style.width = `${clamp(width + 24)}px`; }
            else if (e.key === "Home") { e.preventDefault(); leftPanel.style.width = ""; }
        });
    }

    // =========================================================================
    // 4. Policies, presets, system instruction & prompt editor
    // =========================================================================
    function pulseSwitch(switchEl) {
        if (!switchEl) return;
        switchEl.classList.remove("switch-pulse");
        void switchEl.offsetWidth; // Trigger DOM reflow to restart animation
        switchEl.classList.add("switch-pulse");
        setTimeout(() => switchEl.classList.remove("switch-pulse"), 400);
    }

    function policyState() {
        return {
            inbound: toggleInboundPolicy ? toggleInboundPolicy.checked : true,
            outbound: toggleOutboundPolicy ? toggleOutboundPolicy.checked : true
        };
    }

    function refreshPolicyBadge() {
        const { inbound, outbound } = policyState();
        let label = "FULL DUPLEX";
        let cls = "";
        if (!inbound && !outbound) { label = "BYPASSED"; cls = " badge-leak-test"; }
        else if (!inbound) { label = "OUTBOUND ONLY"; cls = " badge-leak-test"; }
        else if (!outbound) { label = "INBOUND ONLY"; cls = " badge-custom"; }
        policyModeBadge.textContent = label;
        policyModeBadge.className = "policy-mode-badge" + cls;
    }

    function setPolicies(inbound, outbound) {
        if (toggleInboundPolicy.checked !== inbound) { toggleInboundPolicy.checked = inbound; pulseSwitch(switchInbound); }
        if (toggleOutboundPolicy.checked !== outbound) { toggleOutboundPolicy.checked = outbound; pulseSwitch(switchOutbound); }
        refreshPolicyBadge();
    }

    function updateCharBadge() {
        charBadge.textContent = `${promptInput.value.length} / ${config.maxPromptChars} chars`;
    }

    function setSystemInstruction(personaKey) {
        const persona = personaKey ? PERSONAS[personaKey] : null;
        systemInput.value = persona ? persona.text : "";
        refreshSystemBadge(persona ? persona.label : null);
    }

    function refreshSystemBadge(label) {
        const text = systemInput.value.trim();
        systemBadge.textContent = text ? (label || "custom") : "none";
        systemBadge.classList.toggle("active", Boolean(text));
    }

    function parseExpect(value) {
        // "A,B|C" -> [["A"], ["B","C"]] ; each group needs at least one of its alternatives.
        return String(value || "").split(",").map(g => g.trim()).filter(Boolean).map(g => g.split("|"));
    }

    function showScenario(pill) {
        const title = pill.getAttribute("data-title");
        if (!title) { scenarioCallout.style.display = "none"; return; }
        const expect = parseExpect(pill.getAttribute("data-expect"));
        const dir = pill.getAttribute("data-expect-dir");
        scenarioCallout.style.display = "flex";
        scenarioCallout.className = "scenario-context-callout" + (dir === "outbound" ? " leak-mode" : "");
        scenarioCalloutIcon.textContent = dir === "outbound" ? "📤" : (expect.length ? "🎯" : "✅");
        scenarioCalloutTitle.textContent = title;
        scenarioCalloutDesc.textContent = pill.getAttribute("data-desc") || "";
        const persona = PERSONAS[pill.getAttribute("data-system")];
        const parts = [];
        if (expect.length) parts.push("Expect: " + expect.map(g => g.map(labelFor).join(" or ")).join(", "));
        else parts.push("Expect: no findings");
        if (persona) parts.push("Persona: " + persona.label);
        scenarioExpect.textContent = parts.join(" • ");
    }

    function selectPreset(pill) {
        const prompt = pill.getAttribute("data-prompt");
        if (!prompt) return;
        promptInput.value = prompt;
        updateCharBadge();
        document.querySelectorAll(".preset-pill").forEach(p => p.classList.remove("selected"));
        pill.classList.add("selected");
        activePreset = pill;
        setSystemInstruction(pill.getAttribute("data-system"));
        // Presets always demonstrate the protected path; use Compare to show SDP OFF.
        setPolicies(true, true);
        showScenario(pill);
    }

    function presetById(id) {
        return [...document.querySelectorAll(".preset-pill[data-scenario]")].find(p => p.dataset.scenario === id) || null;
    }

    function clearPresetSelection() {
        document.querySelectorAll(".preset-pill").forEach(p => p.classList.remove("selected"));
        activePreset = null;
        scenarioCallout.style.display = "none";
    }

    function initPromptControls() {
        promptInput.addEventListener("input", () => {
            updateCharBadge();
            if (activePreset && promptInput.value !== activePreset.getAttribute("data-prompt")) {
                clearPresetSelection();
            }
        });
        systemInput.addEventListener("input", () => refreshSystemBadge(null));

        promptInput.addEventListener("keydown", (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                runSingle();
            }
        });

        clearBtn.addEventListener("click", () => {
            promptInput.value = "";
            setSystemInstruction(null);
            updateCharBadge();
            clearPresetSelection();
            promptInput.focus();
        });

        document.querySelectorAll(".preset-pill").forEach(pill => {
            pill.addEventListener("click", () => {
                selectPreset(pill);
                promptInput.focus();
            });
        });

        [toggleInboundPolicy, toggleOutboundPolicy].forEach((toggle, i) => {
            toggle.addEventListener("change", () => {
                pulseSwitch(i === 0 ? switchInbound : switchOutbound);
                refreshPolicyBadge();
                if (!toggle.checked) {
                    toast("SDP OFF is a privileged action: only this demo app (sdp_bypass_allowed=true) may do it.", "warn");
                }
            });
        });
        refreshPolicyBadge();
        updateCharBadge();
    }

    // =========================================================================
    // 5. Token highlighting & raw-vs-sanitized alignment (X-ray)
    // =========================================================================
    const TOKEN_RE = /\[([A-Z0-9_]{3,})\]/g;

    /** Highlights [INFO_TYPE] tokens. Tokens whose type is in `caughtOut` are marked as outbound catches. */
    function tokenFragment(text, caughtOut) {
        const frag = document.createDocumentFragment();
        if (!text) return frag;
        const re = /\[([A-Z0-9_]{3,})\]/g;
        let last = 0, m;
        while ((m = re.exec(text)) !== null) {
            if (m.index > last) frag.append(text.slice(last, m.index));
            const cls = caughtOut && caughtOut.has(m[1]) ? "deidentified-token token-caught-out" : "deidentified-token";
            frag.append(h("span", { class: cls, title: labelFor(m[1]) }, m[0]));
            last = re.lastIndex;
        }
        if (last < text.length) frag.append(text.slice(last));
        return frag;
    }

    /**
     * Aligns the raw prompt with its sanitized version to find which raw spans were redacted.
     * Returns [{start, end, types}] or null if the texts cannot be aligned.
     */
    function findRedactions(raw, sanitized) {
        if (!raw || !sanitized) return null;
        const pieces = [];
        let last = 0, m;
        TOKEN_RE.lastIndex = 0;
        while ((m = TOKEN_RE.exec(sanitized)) !== null) {
            pieces.push({ lit: sanitized.slice(last, m.index) });
            pieces.push({ tok: m[1] });
            last = TOKEN_RE.lastIndex;
        }
        pieces.push({ lit: sanitized.slice(last) });

        const spans = [];
        let pos = 0;
        let pending = [];
        for (let i = 0; i < pieces.length; i++) {
            const p = pieces[i];
            if (p.tok) { pending.push(p.tok); continue; }
            const isLast = i === pieces.length - 1;
            if (!pending.length) {
                if (!raw.startsWith(p.lit, pos)) return null;
                pos += p.lit.length;
                continue;
            }
            if (p.lit === "" && !isLast) continue; // adjacent tokens share one raw span
            const idx = isLast && p.lit === "" ? raw.length
                : (isLast ? raw.lastIndexOf(p.lit) : raw.indexOf(p.lit, pos));
            if (idx < pos) return null;
            if (idx > pos) spans.push({ start: pos, end: idx, types: pending });
            pending = [];
            pos = idx + p.lit.length;
        }
        return spans;
    }

    function rawWithRedactions(raw, spans, variant) {
        const frag = document.createDocumentFragment();
        if (!spans || !spans.length) { frag.append(raw); return frag; }
        let pos = 0;
        spans.forEach((s, i) => {
            frag.append(raw.slice(pos, s.start));
            frag.append(h("mark", {
                class: `pii-raw ${variant || ""}`.trim(),
                style: `animation-delay:${0.15 + i * 0.18}s`,
                title: s.types.map(labelFor).join(" + ")
            }, raw.slice(s.start, s.end)));
            pos = s.end;
        });
        frag.append(raw.slice(pos));
        return frag;
    }

    /** Marks every occurrence of the given raw values (used for the unprotected compare pane). */
    function markValues(text, values) {
        const frag = document.createDocumentFragment();
        const vals = [...new Set(values)].sort((a, b) => b.length - a.length);
        if (!text || !vals.length) { frag.append(text || ""); return frag; }
        const re = new RegExp(vals.map(v => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
        let last = 0, m;
        while ((m = re.exec(text)) !== null) {
            frag.append(text.slice(last, m.index), h("mark", { class: "pii-raw pii-leaked" }, m[0]));
            last = re.lastIndex;
        }
        frag.append(text.slice(last));
        return frag;
    }

    function renderLegend(types) {
        fill(xrayLegend, types.map(t =>
            h("span", { class: "legend-chip", title: t }, h("code", null, `[${t}]`), ` ${labelFor(t)}`)));
    }

    function evaluateSelfTest(detectedTypes) {
        if (!activePreset) { selfTest.textContent = ""; selfTest.className = "self-test"; return; }
        const groups = parseExpect(activePreset.getAttribute("data-expect"));
        const detected = new Set(detectedTypes);
        if (!groups.length) {
            const ok = detected.size === 0;
            selfTest.textContent = ok ? "✓ Self-test: no findings, as expected" : `✗ Self-test: unexpected ${[...detected].join(", ")}`;
            selfTest.className = "self-test " + (ok ? "pass" : "fail");
            return;
        }
        const missing = groups.filter(g => !g.some(t => detected.has(t)));
        const hit = groups.length - missing.length;
        selfTest.textContent = missing.length
            ? `✗ Self-test ${hit}/${groups.length}: missing ${missing.map(g => g.map(labelFor).join("/")).join(", ")}`
            : `✓ Self-test ${hit}/${groups.length}: all expected infoTypes detected`;
        selfTest.className = "self-test " + (missing.length ? "fail" : "pass");
    }

    // =========================================================================
    // 6. Pipeline animation & latency breakdown
    // =========================================================================
    const STAGES = ["client", "gateway", "sdp_in", "model", "sdp_out", "done"];

    function pipeNodes() {
        return STAGES.map(s => pipeline.querySelector(`.pipe-node[data-stage="${s}"]`));
    }

    function resetPipeline() {
        clearInterval(pipelineTimer);
        pipeNodes().forEach(n => { n.className = "pipe-node"; });
        pipeline.querySelectorAll(".pipe-ms").forEach(el => { el.textContent = "\u00a0"; });
        pipeline.querySelectorAll("[data-count]").forEach(el => { el.textContent = "de-identify"; el.classList.remove("has-findings"); });
        fill(latencyBar);
    }

    function animatePipeline(policies) {
        resetPipeline();
        const nodes = pipeNodes();
        let i = 0;
        const step = () => {
            if (i > 0 && i <= 3) nodes[i - 1].classList.add("is-done");
            if (i < 4) {
                const n = nodes[i];
                const skipped = (STAGES[i] === "sdp_in" && !policies.inbound);
                n.classList.add(skipped ? "is-skipped" : "is-active");
                i++;
            }
        };
        step();
        pipelineTimer = setInterval(step, 260);
    }

    function setMs(key, ms) {
        const el = pipeline.querySelector(`.pipe-ms[data-ms="${key}"]`);
        if (el) el.textContent = ms === null || ms === undefined ? "" : `${ms} ms`;
    }

    function finishPipeline(data) {
        clearInterval(pipelineTimer);
        const t = data.timing || {};
        const inb = data.inbound || {};
        const outb = data.outbound || {};
        pipeNodes().forEach((n, i) => {
            n.className = "pipe-node is-done";
            const stage = STAGES[i];
            if (stage === "sdp_in" && inb.policyEnabled === false) n.className = "pipe-node is-skipped";
            if (stage === "sdp_out" && outb.policyEnabled === false) n.className = "pipe-node is-skipped";
            if (stage === "sdp_in" && inb.sensitiveDataDetected) n.classList.add("is-masked");
            if (stage === "sdp_out" && outb.sensitiveDataDetected) n.classList.add("is-masked");
        });
        const setCount = (key, info) => {
            const el = pipeline.querySelector(`[data-count="${key}"]`);
            if (!el) return;
            if (info.policyEnabled === false) { el.textContent = "OFF"; return; }
            const n = parseInt(info.findingsCount || "0", 10);
            el.textContent = n ? `${n} masked` : "clean";
            el.classList.toggle("has-findings", n > 0);
        };
        setCount("sdp_in", inb);
        setCount("sdp_out", outb);

        const network = Math.max(0, (data.elapsed_ms || 0) - (t.total || 0));
        setMs("network", t.total ? network : null);
        setMs("gateway", t.gateway);
        setMs("dlp_in", inb.policyEnabled === false ? null : t.dlp_in);
        setMs("model", t.model);
        setMs("dlp_out", outb.policyEnabled === false ? null : t.dlp_out);
        setMs("elapsed", data.elapsed_ms);
        renderLatencyBar(t, network, data.elapsed_ms || 0);
    }

    function renderLatencyBar(t, network, elapsed) {
        if (!t.total || !elapsed) { fill(latencyBar); return; }
        const other = Math.max(0, t.total - (t.gateway || 0) - (t.dlp_in || 0) - (t.model || 0) - (t.dlp_out || 0));
        const segs = [
            ["network", "Network", network], ["gateway", "Apigee policies", (t.gateway || 0) + other],
            ["sdp", "SDP inbound", t.dlp_in || 0], ["model", "Gemini", t.model || 0], ["sdp", "SDP outbound", t.dlp_out || 0]
        ].filter(s => s[2] > 0);
        const sdpShare = Math.round(((t.dlp_in || 0) + (t.dlp_out || 0)) / elapsed * 100);
        fill(latencyBar,
            h("div", { class: "lat-track" }, segs.map(([cls, name, ms]) =>
                h("div", { class: `lat-seg lat-${cls}`, style: `flex:${Number(ms)}`, title: `${name}: ${ms} ms` }))),
            h("div", { class: "lat-caption" },
                "SDP (both directions) = ", h("strong", null, `${sdpShare}%`),
                ` of ${elapsed} ms end-to-end • Gemini ${t.model || 0} ms`));
    }

    function failPipeline(stage) {
        clearInterval(pipelineTimer);
        const idx = STAGES.indexOf(stage);
        pipeNodes().forEach((n, i) => {
            n.className = "pipe-node " + (i < idx ? "is-done" : (i === idx ? "is-error" : "is-skipped"));
        });
    }

    // =========================================================================
    // 7. Execution (single run + compare) and the demo:runresult contract
    // =========================================================================
    async function callGateway(prompt, systemInstruction, inbound, outbound) {
        const res = await fetch("/api/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt, systemInstruction, "sdp-inbound": inbound, "sdp-outbound": outbound })
        });
        let data = {};
        try { data = await res.json(); } catch (e) { data = { success: false, error: "Invalid response from local server" }; }
        if (!res.ok || data.success === false) {
            data.success = false;
            data.status_code = data.status_code || res.status;
        }
        return data;
    }

    function verdictOf(data) {
        if (data.success !== false) return "allowed";
        const code = data.status_code;
        if ([400, 403, 429].includes(code) || data.error_status === "SDP_UNAVAILABLE") return "blocked";
        return "error";
    }

    function sdpSide(info) {
        info = info || {};
        return {
            enabled: info.policyEnabled !== false,
            count: parseInt(info.findingsCount || "0", 10) || 0,
            types: splitTypes(info.findingTypes)
        };
    }

    /** Normalises a gateway result into the shared demo:runresult shape (+ SDP details). */
    function toRunResult(data, mode) {
        const usage = data.usage || {};
        const ok = data.success !== false;
        return {
            ok,
            httpStatus: data.status_code || (ok ? 200 : null),
            latencyMs: data.elapsed_ms ?? null,
            tokens: usage.totalTokenCount ? {
                prompt: usage.promptTokenCount ?? null,
                completion: usage.candidatesTokenCount ?? null,
                total: usage.totalTokenCount
            } : null,
            verdict: verdictOf(data),
            response: ok ? ((data.outbound || {}).modelResponseText || "") : `${data.error_status || "ERROR"}: ${data.error || ""}`,
            requestHeaders: {},
            responseHeaders: data.headers || {},
            scenarioId: activePreset ? activePreset.dataset.scenario : null,
            mode,
            errorStatus: data.error_status || null,
            sdp: { inbound: sdpSide(data.inbound), outbound: sdpSide(data.outbound) }
        };
    }

    function publishResult(result) {
        lastResult = result;
        emit("demo:runresult", result);
        return result;
    }

    function readInputs() {
        const prompt = promptInput.value.trim();
        if (!prompt) {
            toast("Enter a prompt or pick a preset first.", "warn");
            promptInput.focus();
            promptInput.classList.add("input-shake");
            setTimeout(() => promptInput.classList.remove("input-shake"), 450);
            return null;
        }
        return { prompt, systemInstruction: systemInput.value.trim() };
    }

    function setBusy(on) {
        busy = on;
        runBtn.disabled = on;
        compareBtn.disabled = on;
        btnSpinner.style.display = on ? "inline-block" : "none";
    }

    function showRunning(policies) {
        statusPill.textContent = "RUNNING";
        statusPill.className = "status-pill status-running";
        securityBanner.className = "security-banner banner-streaming";
        bannerIcon.textContent = "⏳";
        bannerTitle.textContent = "Processing via Apigee Gateway & Sensitive Data Protection...";
        bannerDesc.textContent = `Inbound SDP ${policies.inbound ? "ON" : "OFF"} • Outbound SDP ${policies.outbound ? "ON" : "OFF"}`;
        metricLatency.textContent = "…";
        metricInboundPII.textContent = policies.inbound ? "Scanning…" : "OFF";
        metricOutboundPII.textContent = policies.outbound ? "Waiting…" : "OFF";
        metricTokens.textContent = "…";
        fill(modelOutputBox, h("span", { class: "placeholder-text" },
            h("span", { class: "stream-cursor" }), " Waiting for Gemini via Apigee…"));
        tokenLeakIndicator.textContent = "EVALUATING";
        tokenLeakIndicator.className = "token-leak-indicator";
        fill(xraySaw, note("…"));
        fill(xrayOut, note("…"));
        selfTest.textContent = "";
        logsLink.style.display = "none";
        animatePipeline(policies);
    }

    async function runSingle() {
        if (busy) return null;
        const input = readInputs();
        if (!input) return null;
        const policies = policyState();
        setBusy(true);
        compareCard.style.display = "none";
        fill(xrayTyped, input.prompt);
        showRunning(policies);
        let data;
        try {
            data = await callGateway(input.prompt, input.systemInstruction, policies.inbound, policies.outbound);
            if (data.success === false) renderExecutionError(data);
            else renderExecutionResults(data, input);
            loadAuditLogs();
        } catch (err) {
            data = { success: false, error_status: "CLIENT_ERROR", error: err.message || String(err) };
            renderExecutionError(data);
        } finally {
            setBusy(false);
        }
        return publishResult(toRunResult(data, "single"));
    }

    async function runCompare() {
        if (busy) return null;
        const input = readInputs();
        if (!input) return null;
        setBusy(true);
        compareCard.style.display = "block";
        ["cmpOffSaw", "cmpOffOut", "cmpOnSaw", "cmpOnOut"].forEach(id => fill($(id), note("…")));
        $("cmpOffMs").textContent = "…";
        $("cmpOnMs").textContent = "…";
        fill(xrayTyped, input.prompt);
        showRunning({ inbound: true, outbound: true });
        let off, on;
        try {
            [off, on] = await Promise.all([
                callGateway(input.prompt, input.systemInstruction, false, false),
                callGateway(input.prompt, input.systemInstruction, true, true)
            ]);
            if (on.success === false) renderExecutionError(on);
            else renderExecutionResults(on, input);
            renderCompare(off, on, input);
            loadAuditLogs();
        } catch (err) {
            on = { success: false, error_status: "CLIENT_ERROR", error: err.message || String(err) };
            renderExecutionError(on);
        } finally {
            setBusy(false);
        }
        const result = toRunResult(on, "compare");
        result.compareOff = off ? toRunResult(off, "compare-off") : null;
        return publishResult(result);
    }

    function userSawText(data) {
        const parts = ((data.sdp_audit || {}).inbound || {}).modelSawParts;
        if (!Array.isArray(parts)) return null;
        return parts.filter(p => p.role === "user").map(p => p.text).join("\n");
    }

    const errorNote = (d) => note(`${d.error_status || "ERROR"}: ${d.error || ""}`, "xray-error");

    function renderCompare(off, on, input) {
        const onSaw = userSawText(on);
        const spans = findRedactions(input.prompt, onSaw);
        const rawValues = (spans || []).map(s => input.prompt.slice(s.start, s.end)).filter(v => v.length > 2);

        // Unprotected: Gemini got the raw prompt; highlight the values SDP would have removed.
        fill($("cmpOffSaw"), rawWithRedactions(input.prompt, spans, "pii-leaked"));
        if (off.success === false) {
            fill($("cmpOffOut"), errorNote(off));
        } else {
            const text = (off.outbound || {}).modelResponseText || "";
            fill($("cmpOffOut"), text ? markValues(text, rawValues) : note("(empty)"));
        }
        $("cmpOffMs").textContent = off.elapsed_ms ? `${off.elapsed_ms} ms` : "--";

        if (on.success === false) {
            fill($("cmpOnSaw"), errorNote(on));
            fill($("cmpOnOut"));
        } else {
            const outTypes = new Set(splitTypes((on.outbound || {}).findingTypes));
            fill($("cmpOnSaw"), tokenFragment(onSaw || input.prompt));
            fill($("cmpOnOut"), tokenFragment((on.outbound || {}).modelResponseText || "", outTypes));
        }
        $("cmpOnMs").textContent = on.elapsed_ms ? `${on.elapsed_ms} ms` : "--";
        compareCard.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    function renderExecutionResults(data, input) {
        const inbound = data.inbound || {};
        const outbound = data.outbound || {};
        const inboundEnabled = inbound.policyEnabled !== false;
        const outboundEnabled = outbound.policyEnabled !== false;
        const hasInbound = inboundEnabled && Boolean(inbound.sensitiveDataDetected);
        const hasOutbound = outboundEnabled && Boolean(outbound.sensitiveDataDetected);
        const inTypes = splitTypes(inbound.findingTypes);
        const outTypes = splitTypes(outbound.findingTypes);
        const usage = data.usage || {};

        finishPipeline(data);

        // Metrics bar
        metricLatency.textContent = `${(data.elapsed_ms || 0).toLocaleString()} ms`;
        metricInboundPII.textContent = !inboundEnabled ? "OFF" : (hasInbound ? `${inbound.findingsCount} masked` : "Clean (0)");
        metricOutboundPII.textContent = !outboundEnabled ? "OFF" : (hasOutbound ? `${outbound.findingsCount} masked` : "Clean (0)");
        metricTokens.textContent = usage.totalTokenCount ? usage.totalTokenCount.toLocaleString() : "--";

        // Status pill & banner
        if (!inboundEnabled || !outboundEnabled) {
            statusPill.textContent = "BYPASSED";
            statusPill.className = "status-pill status-blocked";
            securityBanner.className = "security-banner banner-blocked";
            bannerIcon.textContent = "⚠️";
            bannerTitle.textContent = "SDP partially or fully disabled (privileged bypass)";
            bannerDesc.textContent = `Inbound ${inboundEnabled ? "ON" : "OFF"} • Outbound ${outboundEnabled ? "ON" : "OFF"}. ` +
                "Allowed only because this app has sdp_bypass_allowed=true; the bypass is recorded in Cloud Logging.";
            auditStatusBadge.textContent = "BYPASS • AUDITED";
            auditStatusBadge.className = "audit-status-badge badge-blocked";
        } else if (hasInbound || hasOutbound) {
            statusPill.textContent = "SANITIZED";
            statusPill.className = "status-pill status-blocked";
            securityBanner.className = "security-banner banner-blocked";
            bannerIcon.textContent = "🛡️";
            bannerTitle.textContent = hasInbound && hasOutbound
                ? "Sensitive data masked in both directions"
                : (hasInbound ? "Sensitive data masked before reaching Gemini" : "Model-generated sensitive data masked before reaching you");
            bannerDesc.textContent = `${hasInbound ? `${inbound.findingsCount} value(s) de-identified inbound. ` : ""}` +
                `${hasOutbound ? `${outbound.findingsCount} value(s) de-identified outbound. ` : ""}` +
                `Structured audit event written to Cloud Logging (${config.logId}).`;
            auditStatusBadge.textContent = "SDP ACTIVE • PII MITIGATED";
            auditStatusBadge.className = "audit-status-badge badge-sanitized";
        } else {
            statusPill.textContent = "CLEAN";
            statusPill.className = "status-pill status-success";
            securityBanner.className = "security-banner banner-clean";
            bannerIcon.textContent = "✅";
            bannerTitle.textContent = "No sensitive data detected";
            bannerDesc.textContent = "Both directions were inspected and nothing matched the inspection template.";
            auditStatusBadge.textContent = "ACTIVE MONITORING • CLEAN";
            auditStatusBadge.className = "audit-status-badge badge-clean";
        }

        // Response box
        const outSet = new Set(outTypes);
        fill(modelOutputBox, tokenFragment(outbound.modelResponseText || "No response generated.", outSet));
        if (!outboundEnabled) {
            tokenLeakIndicator.textContent = "UNINSPECTED (OFF)";
            tokenLeakIndicator.className = "token-leak-indicator leak-warn";
        } else if (hasOutbound) {
            tokenLeakIndicator.textContent = `PROTECTED • ${outbound.findingsCount} MASKED`;
            tokenLeakIndicator.className = "token-leak-indicator leak-zero";
        } else {
            tokenLeakIndicator.textContent = "ZERO LEAKAGE";
            tokenLeakIndicator.className = "token-leak-indicator leak-zero";
        }

        // X-ray column 1 & 2: what you typed vs what Gemini saw
        const audit = data.sdp_audit || null;
        const sawParts = audit && audit.inbound ? audit.inbound.modelSawParts : null;
        if (!inboundEnabled) {
            fill(xrayTyped, input.prompt);
            fill(xraySaw,
                h("div", { class: "xray-alert" }, "⚠️ Inbound SDP OFF: Gemini received the raw prompt."),
                h("div", { class: "xray-raw" }, input.prompt));
        } else if (Array.isArray(sawParts)) {
            const userSaw = sawParts.filter(p => p.role === "user").map(p => p.text).join("\n");
            fill(xrayTyped, rawWithRedactions(input.prompt, findRedactions(input.prompt, userSaw)));
            fill(xraySaw, sawParts.map(p => {
                const role = String(p.role || "").replace(/[^a-z]/gi, "");
                return h("div", { class: "xray-part" },
                    h("span", { class: `role-tag role-${role}` }, p.role),
                    h("div", null, tokenFragment(p.text)));
            }));
        } else {
            fill(xrayTyped, input.prompt);
            fill(xraySaw, note(`X-ray unavailable (debug status: ${data.debug_status || "off"}). ` +
                `Findings: ${inTypes.join(", ") || "none"}`));
        }

        // X-ray column 3: outbound
        if (!outboundEnabled) {
            fill(xrayOut, h("div", { class: "xray-alert" }, "⚠️ Outbound SDP OFF: the model response was returned without inspection."));
        } else if (hasOutbound) {
            fill(xrayOut,
                h("div", { class: "xray-caught" }, "Caught on the way out:"),
                outTypes.map(t => [h("span", { class: "threat-tag", title: t }, labelFor(t)), " "]),
                h("p", { class: "xray-note" }, `${outbound.findingsCount} value(s) generated or echoed by the model were ` +
                    "de-identified before the client received them (red tokens in the response)."));
        } else {
            fill(xrayOut,
                h("span", { class: "threat-tag tag-pass" }, "PASS"), " ",
                h("span", { class: "xray-note" }, "No sensitive data in the model output. Echoed tokens (blue) were already masked inbound."));
        }

        const allTypes = [...new Set([...inTypes, ...outTypes])];
        renderLegend(allTypes);
        evaluateSelfTest(allTypes);

        const url = logsExplorerUrl(data.request_id);
        if (url) { logsLink.href = url; logsLink.style.display = "inline-flex"; }

        const headers = data.headers || {};
        rawHeadersBox.textContent = JSON.stringify(headers, null, 2);
        telemetryBadge.textContent = `${Object.keys(headers).length} headers`;
    }

    function renderExecutionError(data) {
        const status = data.error_status || "GATEWAY_ERROR";
        const code = data.status_code;
        let stage = data.stage;
        if (!stage) {
            if (status === "GATEWAY_UNREACHABLE" || status === "CLIENT_ERROR") stage = "client";
            else if (code === 401 || code === 429) stage = "gateway";
            else if (code === 403) stage = "sdp_in";
            else stage = "model";
        }
        failPipeline(stage);

        statusPill.textContent = "ERROR";
        statusPill.className = "status-pill status-blocked";
        securityBanner.className = "security-banner banner-blocked";
        if (status === "SDP_UNAVAILABLE") {
            statusPill.textContent = "BLOCKED";
            bannerIcon.textContent = "🛑";
            bannerTitle.textContent = "Blocked: fail-closed protection";
        } else if (status === "PERMISSION_DENIED") {
            statusPill.textContent = "DENIED";
            bannerIcon.textContent = "🔒";
            bannerTitle.textContent = "SDP bypass not permitted for this app";
        } else if (status === "RESOURCE_EXHAUSTED") {
            statusPill.textContent = "THROTTLED";
            bannerIcon.textContent = "🚦";
            bannerTitle.textContent = "Rate limit or LLM token quota exceeded";
        } else if (status === "UNAUTHENTICATED") {
            bannerIcon.textContent = "🔑";
            bannerTitle.textContent = "API key rejected by Apigee";
        } else {
            bannerIcon.textContent = "❌";
            bannerTitle.textContent = "Gateway execution error";
        }
        const msg = `${status}: ${data.error || "Request failed"}` + (data.request_id ? ` (request ${data.request_id})` : "");
        bannerDesc.textContent = msg;

        metricLatency.textContent = data.elapsed_ms ? `${data.elapsed_ms} ms` : "Error";
        metricInboundPII.textContent = "—";
        metricOutboundPII.textContent = "—";
        metricTokens.textContent = "—";
        tokenLeakIndicator.textContent = "NOTHING RETURNED";
        tokenLeakIndicator.className = "token-leak-indicator leak-warn";
        fill(modelOutputBox, note(msg, "xray-error"));
        fill(xraySaw, note("Request stopped before the model."));
        fill(xrayOut, note("No response."));
        auditStatusBadge.textContent = code ? `HTTP ${code}` : "ERROR";
        auditStatusBadge.className = "audit-status-badge badge-blocked";
        const url = logsExplorerUrl(data.request_id);
        if (url) { logsLink.href = url; logsLink.style.display = "inline-flex"; }
    }

    function initExecution() {
        runBtn.addEventListener("click", runSingle);
        compareBtn.addEventListener("click", runCompare);
        $("btnCloseCompare").addEventListener("click", () => { compareCard.style.display = "none"; });
    }

    // =========================================================================
    // 8. Slide-out admin drawer (Cloud Logging audit trail & analytics)
    // =========================================================================
    const isAdminOpen = () => adminDrawer.classList.contains("open");

    function openAdminDrawer() {
        if (!isAdminOpen()) adminOpener = document.activeElement;
        adminDrawer.classList.add("open");
        adminDrawerBackdrop.classList.add("active");
        adminTab.setAttribute("aria-expanded", "true");
        if (btnCloseAdminDrawer) btnCloseAdminDrawer.focus();
        loadAuditLogs();
    }

    function closeAdminDrawer() {
        if (!isAdminOpen()) return;
        adminDrawer.classList.remove("open");
        adminDrawerBackdrop.classList.remove("active");
        adminTab.setAttribute("aria-expanded", "false");
        if (adminOpener && adminOpener.focus) adminOpener.focus();
        adminOpener = null;
    }

    function initAdminDrawer() {
        [btnOpenAdmin, adminTab, btnOpenAdminFromLeft].forEach(b => { if (b) b.addEventListener("click", openAdminDrawer); });
        if (btnCloseAdminDrawer) btnCloseAdminDrawer.addEventListener("click", closeAdminDrawer);
        if (adminDrawerBackdrop) adminDrawerBackdrop.addEventListener("click", closeAdminDrawer);

        // Time filter buttons
        document.querySelectorAll(".time-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                document.querySelectorAll(".time-btn").forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                selectedTimeHours = parseInt(btn.getAttribute("data-hours"), 10) || 24;
                renderAuditView();
            });
        });

        if (adminDirectionSelect) adminDirectionSelect.addEventListener("change", loadAuditLogs);
        if (adminTableSearch) adminTableSearch.addEventListener("input", renderAuditView);

        // Sync Cloud Logging button
        if (btnRefreshAdmin) {
            btnRefreshAdmin.addEventListener("click", async () => {
                btnRefreshAdmin.classList.add("loading");
                btnRefreshAdmin.disabled = true;
                try {
                    await fetch("/api/admin/refresh", { method: "POST" });
                    await loadAuditLogs();
                    toast("Synced with Cloud Logging", "success");
                } catch (e) {
                    console.error("Refresh failed", e);
                    toast("Cloud Logging sync failed", "error");
                } finally {
                    btnRefreshAdmin.classList.remove("loading");
                    btnRefreshAdmin.disabled = false;
                }
            });
        }
    }

    async function loadAuditLogs() {
        try {
            const dir = adminDirectionSelect ? adminDirectionSelect.value : "all";
            const res = await fetch(`/api/admin/logs?direction=${encodeURIComponent(dir)}`);
            const data = await res.json();
            currentLogs = data.logs || [];
            updateKPIs(data.metrics || {});
            renderAuditView();
        } catch (e) {
            console.error("Failed to load audit logs", e);
        }
    }

    function updateKPIs(metrics) {
        if (kpiTotalScans) kpiTotalScans.textContent = (metrics.total_scans || 0).toLocaleString();
        if (kpiInboundDetected) kpiInboundDetected.textContent = (metrics.inbound_detected || 0).toLocaleString();
        if (kpiOutboundDetected) kpiOutboundDetected.textContent = (metrics.outbound_detected || 0).toLocaleString();
        if (kpiTotalDeidentified) kpiTotalDeidentified.textContent = (metrics.deidentified_applied || 0).toLocaleString();
    }

    function renderAuditView() {
        const query = (adminTableSearch ? adminTableSearch.value : "").trim().toLowerCase();
        const now = Date.now();
        const maxAgeMs = selectedTimeHours * 3600 * 1000;

        const filtered = currentLogs.filter(item => {
            if (now - new Date(item.timestamp).getTime() > maxAgeMs) return false;
            if (!query) return true;
            return (item.deidentifiedText || "").toLowerCase().includes(query) ||
                (item.findingTypes || "").toLowerCase().includes(query) ||
                (item.direction || "").toLowerCase().includes(query) ||
                (item.status || "").toLowerCase().includes(query);
        });

        tableRecordCount.textContent = `${filtered.length} records`;
        renderTableRows(filtered);
        renderTrafficChart(filtered);
        renderInfoTypeChart(filtered);
    }

    const MUTED = "color:var(--text-muted);";

    function renderTableRows(logs) {
        if (!adminTableBody) return;
        if (logs.length === 0) {
            fill(adminTableBody, h("tr", null,
                h("td", { colspan: 7, style: `text-align:center;padding:24px;${MUTED}` }, "No audit entries match the current filter.")));
            return;
        }

        fill(adminTableBody, logs.map(log => {
            const d = new Date(log.timestamp);
            const timeStr = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
            const dateStr = d.toLocaleDateString([], { month: "short", day: "numeric" });
            const isOut = log.direction === "outbound";

            const detected = log.sensitiveDataDetected;
            const logStatus = String(log.status || "");
            let statusClass = detected ? "badge-blocked" : "badge-clean";
            let statusLabel = detected ? "DE-IDENTIFIED" : "CLEAN";
            if (logStatus.startsWith("BLOCKED")) { statusClass = "badge-blocked"; statusLabel = "BLOCKED"; }
            else if (logStatus === "BYPASSED_BY_POLICY") { statusClass = ""; statusLabel = "BYPASSED"; }

            const types = detected && log.findingTypes && log.findingTypes !== "NONE"
                ? log.findingTypes.split(",").map(t => t.trim()).filter(Boolean) : [];
            const infoChips = types.length
                ? types.map(t => [h("span", { class: "chip-infotype", style: "font-size:10px;padding:1px 5px;margin:1px;", title: labelFor(t) }, t), " "])
                : h("span", { style: `${MUTED}font-size:11px;` }, "None");

            const preview = (log.deidentifiedText || "").substring(0, 80);

            return h("tr", null,
                h("td", { style: "font-family:var(--font-mono);font-size:11px;white-space:nowrap;" },
                    h("div", null, h("strong", null, timeStr)),
                    h("div", { style: `${MUTED}font-size:10px;` }, dateStr)),
                h("td", null, h("span", { class: `badge ${isOut ? "outbound-badge" : "inbound-badge"}` }, isOut ? "OUTBOUND" : "INBOUND")),
                h("td", null, infoChips),
                h("td", { style: "font-family:var(--font-mono);font-weight:700;" }, log.findingsCount || "0"),
                h("td", null, h("span", { class: `audit-status-badge ${statusClass}`.trim() }, statusLabel)),
                h("td", { style: "font-family:var(--font-mono);font-size:11px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", title: preview },
                    preview || h("span", { style: MUTED }, "—")),
                h("td", null, h("button", {
                    type: "button", class: "btn-util btn-inspect-log", style: "padding:3px 8px;font-size:11px;",
                    onClick: () => showLogModal(log)
                }, "Inspect")));
        }));
    }

    // =========================================================================
    // 9. Charts (DOM-built bars)
    // =========================================================================
    function stackedBar(name, countText, blockPct, cleanPct, blockColor) {
        const seg = (cls, pct, label, extra) =>
            h("div", { class: `stacked-segment ${cls}`, style: `width:${Number(pct)}%;${extra || ""}` }, pct > 15 ? label : "");
        return h("div", { class: "proxy-bar-item" },
            h("div", { class: "proxy-bar-header" },
                h("span", { class: "proxy-bar-name" }, name),
                h("span", { class: "proxy-bar-count" }, countText)),
            h("div", { class: "stacked-bar-track" },
                seg("segment-blocked", blockPct, `${Math.round(blockPct)}% PII`, blockColor ? `background:${blockColor};` : ""),
                seg("segment-clean", cleanPct, `${Math.round(cleanPct)}% Clean`)));
    }

    function renderTrafficChart(logs) {
        if (!trafficChartContainer) return;
        const inboundTotal = logs.filter(l => l.direction === "inbound").length;
        const inboundBlocked = logs.filter(l => l.direction === "inbound" && l.sensitiveDataDetected).length;
        const outboundTotal = logs.filter(l => l.direction === "outbound").length;
        const outboundBlocked = logs.filter(l => l.direction === "outbound" && l.sensitiveDataDetected).length;

        const inBlockPct = inboundTotal > 0 ? (inboundBlocked / inboundTotal) * 100 : 0;
        const outBlockPct = outboundTotal > 0 ? (outboundBlocked / outboundTotal) * 100 : 0;
        const legend = (color, label) => h("div", { class: "legend-item" },
            h("div", { class: "legend-dot", style: `background:${color}` }), h("span", null, label));

        fill(trafficChartContainer, h("div", { class: "chart-svg-wrap" },
            h("div", { class: "chart-bars-list" },
                stackedBar("Inbound PreFlow Ingress", `${inboundTotal} requests (${inboundBlocked} with PII)`,
                    inBlockPct, inboundTotal > 0 ? 100 - inBlockPct : 100),
                stackedBar("Outbound PostFlow Egress", `${outboundTotal} responses (${outboundBlocked} protected)`,
                    outBlockPct, outboundTotal > 0 ? 100 - outBlockPct : 100, "var(--warning)")),
            h("div", { class: "bar-legend" },
                legend("var(--danger)", "Inbound Sensitive PII"),
                legend("var(--warning)", "Outbound Protected PII"),
                legend("var(--success)", "Clean / Approved"))));
    }

    function renderInfoTypeChart(logs) {
        if (!infoTypeChartContainer) return;
        const counts = {};
        logs.forEach(l => {
            if (l.sensitiveDataDetected && l.findingTypes && l.findingTypes !== "NONE") {
                l.findingTypes.split(",").forEach(t => {
                    const clean = t.trim();
                    if (clean) counts[clean] = (counts[clean] || 0) + 1;
                });
            }
        });

        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        if (sorted.length === 0) {
            fill(infoTypeChartContainer, h("div", { style: `${MUTED}font-style:italic;font-size:12px;` },
                "Zero sensitive infoType findings recorded in this timeframe."));
            return;
        }

        const maxVal = sorted[0][1] || 1;
        fill(infoTypeChartContainer, h("div", { style: "width:100%;display:flex;flex-direction:column;gap:10px;" },
            sorted.map(([type, count]) => h("div", { style: "display:flex;flex-direction:column;gap:3px;" },
                h("div", { style: "display:flex;justify-content:space-between;font-size:11.5px;" },
                    h("span", { style: "font-family:var(--font-mono);font-weight:600;color:var(--text-secondary);", title: labelFor(type) }, type),
                    h("span", { style: "font-family:var(--font-mono);font-weight:700;color:var(--text-main);" }, `${count} findings`)),
                h("div", { style: "height:8px;background:var(--bg-tertiary);border-radius:4px;overflow:hidden;" },
                    h("div", { style: `width:${Math.round((count / maxVal) * 100)}%;height:100%;background:linear-gradient(90deg, var(--google-red), var(--google-yellow));border-radius:4px;` }))))));
    }

    // =========================================================================
    // 10. Modals (architecture diagram & log inspector)
    // =========================================================================
    const isArchOpen = () => archModal.style.display === "flex";
    const isLogOpen = () => logDetailModal.style.display === "flex";

    function openArch() {
        if (!isArchOpen()) archOpener = document.activeElement;
        archModal.style.display = "flex";
        emit("demo:archopen");
        archModalCloseBtn.focus();
    }

    function closeArch() {
        if (!isArchOpen()) return;
        archModal.style.display = "none";
        if (archOpener && archOpener.focus) archOpener.focus();
        archOpener = null;
    }

    function closeLogModal() {
        if (!isLogOpen()) return;
        logDetailModal.style.display = "none";
        if (logOpener && logOpener.focus) logOpener.focus();
        logOpener = null;
    }

    function initArchImage() {
        const img = $("archImg");
        const link = $("archImgLink");
        if (!img) return;
        const fallback = () => {
            const fb = img.dataset.fallback;
            if (!fb || img.getAttribute("src") === fb) return;
            console.warn(`Architecture diagram not found at ${img.getAttribute("src")}; showing placeholder.`);
            img.setAttribute("src", fb);
            if (link) link.setAttribute("href", fb);
        };
        img.addEventListener("error", fallback);
        if (img.complete && img.naturalWidth === 0) fallback();
    }

    function initModals() {
        initArchImage();
        viewArchBtn.addEventListener("click", openArch);
        archModalCloseBtn.addEventListener("click", closeArch);
        archModal.addEventListener("click", (e) => { if (e.target === archModal) closeArch(); });

        modalCloseBtn.addEventListener("click", closeLogModal);
        btnCloseModalBottom.addEventListener("click", closeLogModal);
        logDetailModal.addEventListener("click", (e) => { if (e.target === logDetailModal) closeLogModal(); });

        if (btnCopyModalJson) {
            btnCopyModalJson.addEventListener("click", () => {
                navigator.clipboard.writeText(modalLogJson.textContent).then(() => {
                    const orig = btnCopyModalJson.textContent;
                    btnCopyModalJson.textContent = "Copied!";
                    setTimeout(() => { btnCopyModalJson.textContent = orig; }, 1500);
                });
            });
        }

        // Esc closes the top-most layer only (log detail > architecture > drawer).
        document.addEventListener("keydown", (e) => {
            if (e.key !== "Escape") return;
            if (isLogOpen()) { e.preventDefault(); closeLogModal(); }
            else if (isArchOpen()) { e.preventDefault(); closeArch(); }
            else if (isAdminOpen()) { e.preventDefault(); closeAdminDrawer(); }
        });
    }

    function showLogModal(log) {
        logOpener = document.activeElement;
        const meta = (k, v) => h("div", { class: "modal-meta-item" },
            h("span", { class: "modal-meta-k" }, k), h("span", { class: "modal-meta-v" }, v ?? ""));
        fill(modalMetaGrid,
            meta("Log ID:", log.id),
            meta("Direction:", (log.direction || "").toUpperCase()),
            meta("Timestamp:", log.timestamp),
            meta("Findings Count:", log.findingsCount),
            meta("InfoTypes:", log.findingTypes),
            meta("Destination Log:", log.logName || config.logName));
        modalLogJson.textContent = JSON.stringify(log, null, 2);
        const url = logsExplorerUrl(log.requestId);
        if (modalLogsLink) {
            modalLogsLink.style.display = url ? "inline-flex" : "none";
            if (url) modalLogsLink.href = url;
        }
        logDetailModal.style.display = "flex";
        modalCloseBtn.focus();
    }

    // =========================================================================
    // 11. Facade for the Guided Tour (and anything else) + bootstrap
    // =========================================================================
    function scenarioList() {
        return [...document.querySelectorAll(".preset-pill[data-scenario]")].map(p => ({
            id: p.dataset.scenario,
            label: p.dataset.title || p.textContent.trim(),
            description: p.dataset.desc || "",
            prompt: p.dataset.prompt || "",
            expect: p.dataset.expect ? "masked" : "allowed"
        }));
    }

    function loadScenario(id) {
        const pill = presetById(id);
        if (!pill) return false;
        closeAdminDrawer();
        selectPreset(pill);
        pill.scrollIntoView({ behavior: "smooth", block: "nearest" });
        return true;
    }

    // Notice dismiss logic
    const disclaimerCloseBtn = $("disclaimerCloseBtn");
    const disclaimerPanel = $("disclaimerPanel");
    if (disclaimerCloseBtn && disclaimerPanel) {
        disclaimerCloseBtn.addEventListener("click", () => {
            disclaimerPanel.style.opacity = "0";
            setTimeout(() => { disclaimerPanel.style.display = "none"; }, 200);
        });
    }

    initTheme();
    initSplitter();
    initPromptControls();
    initExecution();
    initAdminDrawer();
    initModals();

    window.demoApp = {
        slug: DEMO_SLUG,
        loadScenario,
        run: runSingle,
        compare: runCompare,
        isRunning: () => busy,
        scenarios: scenarioList,
        selectedScenario: () => (activePreset ? activePreset.dataset.scenario : null),
        lastResult: () => lastResult,
        isMock: () => false,
        openAdmin: openAdminDrawer, closeAdmin: closeAdminDrawer, isAdminOpen,
        openArch, closeArch, isArchOpen,
        isOverlayOpen: () => isArchOpen() || isAdminOpen() || isLogOpen(),
        setPolicies,
        toast, setTheme
    };
    emit("demo:ready", { slug: DEMO_SLUG });

    loadConfig();
    loadAuditLogs(); // initial fetch of background logs for KPIs
});
