/**
 * Apigee X + Sensitive Data Protection (Cloud DLP) Demonstration Client
 * Google Cloud Minimalist Enterprise Design System & Live Telemetry Inspector
 *
 * Views:
 *   - Pipeline: live request path with real per-stage latency (X-SDP-Timing header)
 *   - SDP X-ray: what you typed -> what Gemini saw (sanitized, from the gateway) -> outbound SDP
 *   - Compare: the same prompt with SDP OFF vs ON (demo app only: sdp_bypass_allowed=true)
 *   - Present: guided, keyboard-driven demo storyline
 */

document.addEventListener("DOMContentLoaded", () => {
    // --- State ---
    let currentLogs = [];
    let selectedTimeHours = 24;
    let busy = false;
    let pipelineTimer = null;
    let activePreset = null;
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
    const systemDetails = $("systemDetails");
    const systemBadge = $("systemBadge");
    const charBadge = $("charBadge");
    const clearBtn = $("clearBtn");
    const sendBtn = $("sendBtn");
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
    const btnScrollToAdmin = $("btnScrollToAdmin");
    const floatingAdminTrigger = $("floatingAdminTrigger");
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
    const btnViewArch = $("btnViewArch");
    const btnCloseArchModal = $("btnCloseArchModal");

    const logDetailModal = $("logDetailModal");
    const modalCloseBtn = $("modalCloseBtn");
    const btnCloseModalBottom = $("btnCloseModalBottom");
    const btnCopyModalJson = $("btnCopyModalJson");
    const modalMetaGrid = $("modalMetaGrid");
    const modalLogJson = $("modalLogJson");
    const modalLogsLink = $("modalLogsLink");

    // =========================================================================
    // 0. Utilities: escaping, toasts, config, Cloud Logging links
    // =========================================================================
    function escapeHtml(text) {
        if (text === null || text === undefined) return "";
        return String(text)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function toast(message, kind = "info") {
        const container = $("toastContainer");
        if (!container) return;
        const el = document.createElement("div");
        el.className = `toast toast-${kind}`;
        el.textContent = message;
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
            if (!res.ok) return;
            config = Object.assign(config, await res.json());
        } catch (e) {
            console.warn("Using default config", e);
        }
        const prettyModel = config.model.replace(/^gemini-/, "Gemini ").replace(/-/g, " ")
            .replace(/\b(flash|lite|pro)\b/gi, w => w[0].toUpperCase() + w.slice(1));
        $("brandSubtitle").textContent = `${prettyModel} • Bidirectional Inbound & Outbound PII Governance`;
        $("pipeModelName").textContent = config.model.replace(/^gemini-/, "");
        $("endpointPath").textContent = `POST ${config.proxyUrl}`;
        $("headerLogId").textContent = config.logId;
        $("adminLogBadge").textContent = config.logId;
        $("adminProjectBadge").textContent = config.project;
        $("archLogPath").textContent = config.logName;
        $("archModel").textContent = config.model;
        $("archTemplates").textContent = `${config.inspectTemplate} / ${config.deidentifyTemplate}`;
        if (config.apiKeyConfigured === false) {
            toast("APIGEE_API_KEY is not configured: run ./setup-apigee-resources.sh", "error");
        }
    }

    // =========================================================================
    // 1. Theme Management (Light & Modern Dark)
    // =========================================================================
    function initTheme() {
        const savedTheme = localStorage.getItem("apigee_sdp_theme") || "light";
        applyTheme(savedTheme);

        if (themeToggleBtn) {
            themeToggleBtn.addEventListener("click", () => {
                const current = document.documentElement.getAttribute("data-theme") || "light";
                const next = current === "light" ? "dark" : "light";
                applyTheme(next);
                localStorage.setItem("apigee_sdp_theme", next);
            });
        }
    }

    function applyTheme(theme) {
        document.documentElement.setAttribute("data-theme", theme);
        if (themeIconSun && themeIconMoon) {
            themeIconSun.style.display = theme === "dark" ? "none" : "block";
            themeIconMoon.style.display = theme === "dark" ? "block" : "none";
        }
    }

    // =========================================================================
    // 2. Resizable Splitter Logic
    // =========================================================================
    function initSplitter() {
        if (!splitter || !leftPanel || !workspaceLayout) return;

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
                let newWidth = moveEvent.clientX - rect.left;
                if (newWidth < 340) newWidth = 340;
                if (newWidth > 750) newWidth = 750;
                leftPanel.style.width = `${newWidth}px`;
            }

            function onMouseUp() {
                if (isDragging) {
                    isDragging = false;
                    splitter.classList.remove("active");
                    document.body.style.cursor = "";
                    document.body.style.userSelect = "";
                    window.removeEventListener("mousemove", onMouseMove);
                    window.removeEventListener("mouseup", onMouseUp);
                }
            }

            window.addEventListener("mousemove", onMouseMove);
            window.addEventListener("mouseup", onMouseUp);
        });
    }

    // =========================================================================
    // 3. Policies, Presets, System Instruction & Prompt Editor
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
        const title = pill.getAttribute("data-scenario");
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
    // 4. Token highlighting & raw-vs-sanitized alignment (X-ray)
    // =========================================================================
    const TOKEN_RE = /\[([A-Z0-9_]{3,})\]/g;

    /** Highlights [INFO_TYPE] tokens. Tokens whose type is in `caughtOut` are marked as outbound catches. */
    function highlightTokens(text, caughtOut) {
        if (!text) return "";
        return escapeHtml(text).replace(/\[([A-Z0-9_]{3,})\]/g, (m, type) => {
            const cls = caughtOut && caughtOut.has(type) ? "deidentified-token token-caught-out" : "deidentified-token";
            return `<span class="${cls}" title="${escapeHtml(labelFor(type))}">${m}</span>`;
        });
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

    function renderRawWithRedactions(raw, spans, variant) {
        if (!spans || !spans.length) return escapeHtml(raw);
        let html = "", pos = 0;
        spans.forEach((s, i) => {
            html += escapeHtml(raw.slice(pos, s.start));
            const label = s.types.map(labelFor).join(" + ");
            html += `<mark class="pii-raw ${variant || ""}" style="animation-delay:${0.15 + i * 0.18}s" ` +
                `title="${escapeHtml(label)}">${escapeHtml(raw.slice(s.start, s.end))}</mark>`;
            pos = s.end;
        });
        return html + escapeHtml(raw.slice(pos));
    }

    function renderLegend(types) {
        if (!types.length) { xrayLegend.innerHTML = ""; return; }
        xrayLegend.innerHTML = types.map(t =>
            `<span class="legend-chip" title="${escapeHtml(t)}"><code>[${escapeHtml(t)}]</code> ${escapeHtml(labelFor(t))}</span>`
        ).join("");
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
    // 5. Pipeline animation & latency breakdown
    // =========================================================================
    const STAGES = ["client", "gateway", "sdp_in", "model", "sdp_out", "done"];

    function pipeNodes() {
        return STAGES.map(s => pipeline.querySelector(`.pipe-node[data-stage="${s}"]`));
    }

    function resetPipeline() {
        clearInterval(pipelineTimer);
        pipeNodes().forEach(n => { n.className = "pipe-node"; });
        pipeline.querySelectorAll(".pipe-ms").forEach(el => { el.innerHTML = "&nbsp;"; });
        pipeline.querySelectorAll("[data-count]").forEach(el => { el.textContent = "de-identify"; el.classList.remove("has-findings"); });
        latencyBar.innerHTML = "";
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
        const nodes = pipeNodes();
        nodes.forEach((n, i) => {
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
        if (!t.total || !elapsed) { latencyBar.innerHTML = ""; return; }
        const other = Math.max(0, t.total - (t.gateway || 0) - (t.dlp_in || 0) - (t.model || 0) - (t.dlp_out || 0));
        const segs = [
            ["network", "Network", network], ["gateway", "Apigee policies", (t.gateway || 0) + other],
            ["sdp", "SDP inbound", t.dlp_in || 0], ["model", "Gemini", t.model || 0], ["sdp", "SDP outbound", t.dlp_out || 0]
        ].filter(s => s[2] > 0);
        const sdpShare = Math.round(((t.dlp_in || 0) + (t.dlp_out || 0)) / elapsed * 100);
        latencyBar.innerHTML = `<div class="lat-track">` + segs.map(([cls, name, ms]) =>
            `<div class="lat-seg lat-${cls}" style="flex:${ms}" title="${name}: ${ms} ms"></div>`).join("") +
            `</div><div class="lat-caption">SDP (both directions) = <strong>${sdpShare}%</strong> of ${elapsed} ms end-to-end • ` +
            `Gemini ${t.model || 0} ms</div>`;
    }

    function failPipeline(stage) {
        clearInterval(pipelineTimer);
        const idx = STAGES.indexOf(stage);
        pipeNodes().forEach((n, i) => {
            n.className = "pipe-node " + (i < idx ? "is-done" : (i === idx ? "is-error" : "is-skipped"));
        });
    }

    // =========================================================================
    // 6. Execution (single run + compare)
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
        sendBtn.disabled = on;
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
        modelOutputBox.innerHTML = '<span class="placeholder-text"><span class="stream-cursor"></span> Waiting for Gemini via Apigee…</span>';
        tokenLeakIndicator.textContent = "EVALUATING";
        tokenLeakIndicator.className = "token-leak-indicator";
        const pending = '<span class="xray-empty">…</span>';
        xraySaw.innerHTML = pending;
        xrayOut.innerHTML = pending;
        selfTest.textContent = "";
        logsLink.style.display = "none";
        animatePipeline(policies);
    }

    async function runSingle() {
        if (busy) return;
        const input = readInputs();
        if (!input) return;
        const policies = policyState();
        setBusy(true);
        compareCard.style.display = "none";
        xrayTyped.innerHTML = escapeHtml(input.prompt);
        showRunning(policies);
        try {
            const data = await callGateway(input.prompt, input.systemInstruction, policies.inbound, policies.outbound);
            if (data.success === false) renderExecutionError(data);
            else renderExecutionResults(data, input);
            loadAuditLogs();
            return data;
        } catch (err) {
            renderExecutionError({ error_status: "CLIENT_ERROR", error: err.message || String(err) });
        } finally {
            setBusy(false);
        }
    }

    async function runCompare() {
        if (busy) return;
        const input = readInputs();
        if (!input) return;
        setBusy(true);
        compareCard.style.display = "block";
        ["cmpOffSaw", "cmpOffOut", "cmpOnSaw", "cmpOnOut"].forEach(id => { $(id).innerHTML = '<span class="xray-empty">…</span>'; });
        $("cmpOffMs").textContent = "…";
        $("cmpOnMs").textContent = "…";
        xrayTyped.innerHTML = escapeHtml(input.prompt);
        showRunning({ inbound: true, outbound: true });
        try {
            const [off, on] = await Promise.all([
                callGateway(input.prompt, input.systemInstruction, false, false),
                callGateway(input.prompt, input.systemInstruction, true, true)
            ]);
            if (on.success === false) renderExecutionError(on);
            else renderExecutionResults(on, input);
            renderCompare(off, on, input);
            loadAuditLogs();
        } catch (err) {
            renderExecutionError({ error_status: "CLIENT_ERROR", error: err.message || String(err) });
        } finally {
            setBusy(false);
        }
    }

    function userSawText(data) {
        const parts = ((data.sdp_audit || {}).inbound || {}).modelSawParts;
        if (!Array.isArray(parts)) return null;
        return parts.filter(p => p.role === "user").map(p => p.text).join("\n");
    }

    function renderCompare(off, on, input) {
        const onSaw = userSawText(on);
        const spans = findRedactions(input.prompt, onSaw);
        const rawValues = (spans || []).map(s => input.prompt.slice(s.start, s.end)).filter(v => v.length > 2);

        // Unprotected: Gemini got the raw prompt; highlight the values SDP would have removed.
        $("cmpOffSaw").innerHTML = renderRawWithRedactions(input.prompt, spans, "pii-leaked");
        if (off.success === false) {
            $("cmpOffOut").innerHTML = `<span class="xray-error">${escapeHtml(off.error_status)}: ${escapeHtml(off.error)}</span>`;
        } else {
            let html = escapeHtml((off.outbound || {}).modelResponseText || "");
            rawValues.forEach(v => {
                const esc = escapeHtml(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                html = html.replace(new RegExp(esc, "g"), `<mark class="pii-raw pii-leaked">${escapeHtml(v)}</mark>`);
            });
            $("cmpOffOut").innerHTML = html || '<span class="xray-empty">(empty)</span>';
        }
        $("cmpOffMs").textContent = off.elapsed_ms ? `${off.elapsed_ms} ms` : "--";

        if (on.success === false) {
            $("cmpOnSaw").innerHTML = `<span class="xray-error">${escapeHtml(on.error_status)}: ${escapeHtml(on.error)}</span>`;
            $("cmpOnOut").innerHTML = "";
        } else {
            const outTypes = new Set(splitTypes((on.outbound || {}).findingTypes));
            $("cmpOnSaw").innerHTML = highlightTokens(onSaw || input.prompt);
            $("cmpOnOut").innerHTML = highlightTokens((on.outbound || {}).modelResponseText || "", outTypes);
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
        const modelText = outbound.modelResponseText || "No response generated.";
        modelOutputBox.innerHTML = highlightTokens(modelText, outSet);
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
            xrayTyped.innerHTML = escapeHtml(input.prompt);
            xraySaw.innerHTML = `<div class="xray-alert">⚠️ Inbound SDP OFF: Gemini received the raw prompt.</div>` +
                `<div class="xray-raw">${escapeHtml(input.prompt)}</div>`;
        } else if (Array.isArray(sawParts)) {
            const userSaw = sawParts.filter(p => p.role === "user").map(p => p.text).join("\n");
            const spans = findRedactions(input.prompt, userSaw);
            xrayTyped.innerHTML = renderRawWithRedactions(input.prompt, spans);
            xraySaw.innerHTML = sawParts.map(p =>
                `<div class="xray-part"><span class="role-tag role-${escapeHtml(p.role)}">${escapeHtml(p.role)}</span>` +
                `<div>${highlightTokens(p.text)}</div></div>`).join("");
        } else {
            xrayTyped.innerHTML = escapeHtml(input.prompt);
            xraySaw.innerHTML = `<span class="xray-empty">X-ray unavailable (debug status: ${escapeHtml(data.debug_status || "off")}). ` +
                `Findings: ${escapeHtml(inTypes.join(", ") || "none")}</span>`;
        }

        // X-ray column 3: outbound
        if (!outboundEnabled) {
            xrayOut.innerHTML = `<div class="xray-alert">⚠️ Outbound SDP OFF: the model response was returned without inspection.</div>`;
        } else if (hasOutbound) {
            xrayOut.innerHTML = `<div class="xray-caught">Caught on the way out:</div>` +
                outTypes.map(t => `<span class="threat-tag" title="${escapeHtml(t)}">${escapeHtml(labelFor(t))}</span>`).join(" ") +
                `<p class="xray-note">${escapeHtml(outbound.findingsCount)} value(s) generated or echoed by the model were ` +
                `de-identified before the client received them (red tokens in the response).</p>`;
        } else {
            xrayOut.innerHTML = `<span class="threat-tag tag-pass">PASS</span> <span class="xray-note">No sensitive data in the model output. ` +
                `Echoed tokens (blue) were already masked inbound.</span>`;
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
        modelOutputBox.innerHTML = `<span class="xray-error">${escapeHtml(msg)}</span>`;
        xraySaw.innerHTML = '<span class="xray-empty">Request stopped before the model.</span>';
        xrayOut.innerHTML = '<span class="xray-empty">No response.</span>';
        auditStatusBadge.textContent = code ? `HTTP ${code}` : "ERROR";
        auditStatusBadge.className = "audit-status-badge badge-blocked";
        const url = logsExplorerUrl(data.request_id);
        if (url) { logsLink.href = url; logsLink.style.display = "inline-flex"; }
    }

    function initExecution() {
        sendBtn.addEventListener("click", runSingle);
        compareBtn.addEventListener("click", runCompare);
        $("btnCloseCompare").addEventListener("click", () => { compareCard.style.display = "none"; });
    }

    // =========================================================================
    // 7. Guided demo (Present mode)
    // =========================================================================
    const BEATS = [
        { preset: "clean-api", action: "run", title: "Baseline: a clean prompt",
          note: "Nothing sensitive, so nothing is masked. Watch the pipeline: SDP adds only tens of milliseconds around the Gemini call." },
        { preset: "bank-refund", action: "run", title: "Sensitive data never reaches the model",
          note: "Name, NRIC, card and email are replaced at the gateway. The X-ray shows exactly what Gemini received, and it still completes the refund." },
        { preset: "bank-refund", action: "compare", title: "With vs without the gateway",
          note: "The same prompt with SDP OFF (red) and ON (green). Only this privileged demo app may switch SDP off; every other app gets HTTP 403." },
        { preset: "outbound-reassemble", action: "run", title: "Catching what the model rebuilds",
          note: "The card number and NRIC arrive as harmless-looking fragments, so inbound SDP has nothing to mask. Gemini stitches them together, and outbound SDP catches them before they reach the client." },
        { preset: "secrets", action: "run", title: "Beyond PII: developer secrets",
          note: "Engineers paste configs into AI assistants. The Google API key and password are stripped before the prompt leaves the gateway." },
        { preset: null, action: "audit", title: "Every decision is audited",
          note: "Each request writes sanitized, structured entries to Cloud Logging. No raw values are stored anywhere." }
    ];
    let beatIndex = -1;

    function presetById(id) {
        return document.querySelector(`.preset-pill[data-id="${id}"]`);
    }

    function showBeat(i) {
        beatIndex = Math.max(0, Math.min(BEATS.length - 1, i));
        const beat = BEATS[beatIndex];
        $("presentStep").textContent = `${beatIndex + 1} / ${BEATS.length}`;
        $("presentTitle").textContent = beat.title;
        $("presentNote").textContent = beat.note;
        $("presentRun").textContent = beat.action === "compare" ? "⚖️ Compare" : (beat.action === "audit" ? "📊 Open audit" : "▶ Run");
        $("presentPrev").disabled = beatIndex === 0;
        $("presentNext").disabled = beatIndex === BEATS.length - 1;
        closeAdminDrawer();
        if (beat.preset) {
            const pill = presetById(beat.preset);
            if (pill) { selectPreset(pill); pill.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
        }
    }

    function runBeat() {
        const beat = BEATS[beatIndex];
        if (!beat) return;
        if (beat.action === "run") runSingle();
        else if (beat.action === "compare") runCompare();
        else if (beat.action === "audit") openAdminDrawer();
    }

    function startPresent() {
        document.body.classList.add("presenting");
        $("presentBar").style.display = "flex";
        showBeat(0);
    }

    function stopPresent() {
        document.body.classList.remove("presenting");
        $("presentBar").style.display = "none";
        beatIndex = -1;
    }

    function initPresent() {
        $("btnPresent").addEventListener("click", () => (beatIndex < 0 ? startPresent() : stopPresent()));
        $("presentPrev").addEventListener("click", () => showBeat(beatIndex - 1));
        $("presentNext").addEventListener("click", () => showBeat(beatIndex + 1));
        $("presentRun").addEventListener("click", runBeat);
        $("presentExit").addEventListener("click", stopPresent);
        document.addEventListener("keydown", (e) => {
            if (beatIndex < 0) return;
            const typing = ["TEXTAREA", "INPUT", "SELECT"].includes(document.activeElement && document.activeElement.tagName);
            if (e.key === "Escape") { stopPresent(); return; }
            if (typing) return;
            if (e.key === "ArrowRight") { e.preventDefault(); showBeat(beatIndex + 1); }
            else if (e.key === "ArrowLeft") { e.preventDefault(); showBeat(beatIndex - 1); }
            else if (e.key === "Enter") { e.preventDefault(); runBeat(); }
        });
    }

    // =========================================================================
    // 8. Slide-Out Admin Drawer (Cloud Logging Audit Trail & Analytics)
    // =========================================================================
    function openAdminDrawer() {
        adminDrawer.classList.add("open");
        adminDrawerBackdrop.classList.add("active");
        loadAuditLogs();
    }

    function closeAdminDrawer() {
        adminDrawer.classList.remove("open");
        adminDrawerBackdrop.classList.remove("active");
    }

    function initAdminDrawer() {
        if (btnScrollToAdmin) btnScrollToAdmin.addEventListener("click", openAdminDrawer);
        if (floatingAdminTrigger) floatingAdminTrigger.addEventListener("click", openAdminDrawer);
        if (btnOpenAdminFromLeft) btnOpenAdminFromLeft.addEventListener("click", openAdminDrawer);
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

        // Direction dropdown
        if (adminDirectionSelect) {
            adminDirectionSelect.addEventListener("change", () => {
                loadAuditLogs();
            });
        }

        // Search input
        if (adminTableSearch) {
            adminTableSearch.addEventListener("input", () => {
                renderAuditView();
            });
        }

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
        const now = new Date().getTime();
        const maxAgeMs = selectedTimeHours * 3600 * 1000;

        // Filter logs by time and search query
        const filtered = currentLogs.filter(item => {
            const itemTime = new Date(item.timestamp).getTime();
            if (now - itemTime > maxAgeMs) return false;

            if (!query) return true;
            const textMatch = (item.deidentifiedText || "").toLowerCase().includes(query) ||
                              (item.findingTypes || "").toLowerCase().includes(query) ||
                              (item.direction || "").toLowerCase().includes(query) ||
                              (item.status || "").toLowerCase().includes(query);
            return textMatch;
        });

        tableRecordCount.textContent = `${filtered.length} records`;
        renderTableRows(filtered);
        renderTrafficChart(filtered);
        renderInfoTypeChart(filtered);
    }

    function renderTableRows(logs) {
        if (!adminTableBody) return;
        if (logs.length === 0) {
            adminTableBody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--text-muted);">No audit entries match the current filter.</td></tr>';
            return;
        }

        let html = "";
        logs.forEach(log => {
            const d = new Date(log.timestamp);
            const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const dateStr = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
            const isOut = log.direction === "outbound";
            const dirBadge = isOut 
                ? '<span class="badge outbound-badge">OUTBOUND</span>' 
                : '<span class="badge inbound-badge">INBOUND</span>';

            const detected = log.sensitiveDataDetected;
            const logStatus = String(log.status || "");
            let statusClass = detected ? "badge-blocked" : "badge-clean";
            let statusLabel = detected ? "DE-IDENTIFIED" : "CLEAN";
            if (logStatus.startsWith("BLOCKED")) {
                statusClass = "badge-blocked";
                statusLabel = "BLOCKED";
            } else if (logStatus === "BYPASSED_BY_POLICY") {
                statusClass = "";
                statusLabel = "BYPASSED";
            }

            // InfoType chips
            let infoChips = "";
            if (detected && log.findingTypes && log.findingTypes !== "NONE") {
                const types = log.findingTypes.split(",");
                types.forEach(t => {
                    infoChips += `<span class="chip-infotype" style="font-size:10px;padding:1px 5px;margin:1px;" title="${escapeHtml(labelFor(t.trim()))}">${escapeHtml(t.trim())}</span> `;
                });
            } else {
                infoChips = '<span style="color:var(--text-muted);font-size:11px;">None</span>';
            }

            const preview = escapeHtml((log.deidentifiedText || "").substring(0, 80));

            html += `
                <tr>
                    <td style="font-family:var(--font-mono);font-size:11px;white-space:nowrap;">
                        <div><strong>${timeStr}</strong></div>
                        <div style="color:var(--text-muted);font-size:10px;">${dateStr}</div>
                    </td>
                    <td>${dirBadge}</td>
                    <td>${infoChips}</td>
                    <td style="font-family:var(--font-mono);font-weight:700;">${escapeHtml(log.findingsCount || "0")}</td>
                    <td><span class="audit-status-badge ${statusClass}">${statusLabel}</span></td>
                    <td style="font-family:var(--font-mono);font-size:11px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${preview}">
                        ${preview || '<span style="color:var(--text-muted)">—</span>'}
                    </td>
                    <td>
                        <button class="btn-util btn-inspect-log" data-log-id="${escapeHtml(log.id)}" style="padding:3px 8px;font-size:11px;">Inspect</button>
                    </td>
                </tr>
            `;
        });

        adminTableBody.innerHTML = html;

        // Wire inspect buttons
        document.querySelectorAll(".btn-inspect-log").forEach(btn => {
            btn.addEventListener("click", () => {
                const logId = btn.getAttribute("data-log-id");
                const found = currentLogs.find(l => l.id === logId);
                if (found) showLogModal(found);
            });
        });
    }

    // =========================================================================
    // 9. Dynamic Charts Rendering
    // =========================================================================
    function renderTrafficChart(logs) {
        if (!trafficChartContainer) return;

        const inboundTotal = logs.filter(l => l.direction === "inbound").length;
        const inboundBlocked = logs.filter(l => l.direction === "inbound" && l.sensitiveDataDetected).length;

        const outboundTotal = logs.filter(l => l.direction === "outbound").length;
        const outboundBlocked = logs.filter(l => l.direction === "outbound" && l.sensitiveDataDetected).length;

        const inBlockPct = inboundTotal > 0 ? (inboundBlocked / inboundTotal) * 100 : 0;
        const inCleanPct = inboundTotal > 0 ? (100 - inBlockPct) : 100;

        const outBlockPct = outboundTotal > 0 ? (outboundBlocked / outboundTotal) * 100 : 0;
        const outCleanPct = outboundTotal > 0 ? (100 - outBlockPct) : 100;

        trafficChartContainer.innerHTML = `
            <div class="chart-svg-wrap">
                <div class="chart-bars-list">
                    <div class="proxy-bar-item">
                        <div class="proxy-bar-header">
                            <span class="proxy-bar-name">Inbound PreFlow Ingress</span>
                            <span class="proxy-bar-count">${inboundTotal} requests (${inboundBlocked} with PII)</span>
                        </div>
                        <div class="stacked-bar-track">
                            <div class="stacked-segment segment-blocked" style="width:${inBlockPct}%">${inBlockPct > 15 ? Math.round(inBlockPct) + "% PII" : ""}</div>
                            <div class="stacked-segment segment-clean" style="width:${inCleanPct}%">${inCleanPct > 15 ? Math.round(inCleanPct) + "% Clean" : ""}</div>
                        </div>
                    </div>

                    <div class="proxy-bar-item">
                        <div class="proxy-bar-header">
                            <span class="proxy-bar-name">Outbound PostFlow Egress</span>
                            <span class="proxy-bar-count">${outboundTotal} responses (${outboundBlocked} protected)</span>
                        </div>
                        <div class="stacked-bar-track">
                            <div class="stacked-segment segment-blocked" style="width:${outBlockPct}%;background:var(--warning);">${outBlockPct > 15 ? Math.round(outBlockPct) + "% PII" : ""}</div>
                            <div class="stacked-segment segment-clean" style="width:${outCleanPct}%">${outCleanPct > 15 ? Math.round(outCleanPct) + "% Clean" : ""}</div>
                        </div>
                    </div>
                </div>

                <div class="bar-legend">
                    <div class="legend-item">
                        <div class="legend-dot" style="background:var(--danger)"></div>
                        <span>Inbound Sensitive PII</span>
                    </div>
                    <div class="legend-item">
                        <div class="legend-dot" style="background:var(--warning)"></div>
                        <span>Outbound Protected PII</span>
                    </div>
                    <div class="legend-item">
                        <div class="legend-dot" style="background:var(--success)"></div>
                        <span>Clean / Approved</span>
                    </div>
                </div>
            </div>
        `;
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
            infoTypeChartContainer.innerHTML = '<div style="color:var(--text-muted);font-style:italic;font-size:12px;">Zero sensitive infoType findings recorded in this timeframe.</div>';
            return;
        }

        const maxVal = sorted[0][1] || 1;
        let html = '<div style="width:100%;display:flex;flex-direction:column;gap:10px;">';
        sorted.forEach(([type, count]) => {
            const pct = Math.round((count / maxVal) * 100);
            html += `
                <div style="display:flex;flex-direction:column;gap:3px;">
                    <div style="display:flex;justify-content:space-between;font-size:11.5px;">
                        <span style="font-family:var(--font-mono);font-weight:600;color:var(--text-secondary);" title="${escapeHtml(labelFor(type))}">${escapeHtml(type)}</span>
                        <span style="font-family:var(--font-mono);font-weight:700;color:var(--text-main);">${count} findings</span>
                    </div>
                    <div style="height:8px;background:var(--bg-tertiary);border-radius:4px;overflow:hidden;">
                        <div style="width:${pct}%;height:100%;background:linear-gradient(90deg, #ea4335, #fbbc04);border-radius:4px;"></div>
                    </div>
                </div>
            `;
        });
        html += '</div>';
        infoTypeChartContainer.innerHTML = html;
    }

    // =========================================================================
    // 10. Modals (Architecture Diagram & Log Inspector)
    // =========================================================================
    function initModals() {
        // Architecture Modal
        if (btnViewArch) {
            btnViewArch.addEventListener("click", () => {
                archModal.style.display = "flex";
            });
        }
        if (btnCloseArchModal) {
            btnCloseArchModal.addEventListener("click", () => {
                archModal.style.display = "none";
            });
        }
        if (archModal) {
            archModal.addEventListener("click", (e) => {
                if (e.target === archModal) archModal.style.display = "none";
            });
        }

        // Log Detail Modal
        if (modalCloseBtn) modalCloseBtn.addEventListener("click", () => logDetailModal.style.display = "none");
        if (btnCloseModalBottom) btnCloseModalBottom.addEventListener("click", () => logDetailModal.style.display = "none");
        if (logDetailModal) {
            logDetailModal.addEventListener("click", (e) => {
                if (e.target === logDetailModal) logDetailModal.style.display = "none";
            });
        }

        if (btnCopyModalJson) {
            btnCopyModalJson.addEventListener("click", () => {
                navigator.clipboard.writeText(modalLogJson.textContent).then(() => {
                    const orig = btnCopyModalJson.textContent;
                    btnCopyModalJson.textContent = "Copied!";
                    setTimeout(() => btnCopyModalJson.textContent = orig, 1500);
                });
            });
        }

        document.addEventListener("keydown", (e) => {
            if (e.key !== "Escape") return;
            if (archModal.style.display === "flex") archModal.style.display = "none";
            if (logDetailModal.style.display === "flex") logDetailModal.style.display = "none";
            if (adminDrawer.classList.contains("open")) closeAdminDrawer();
        });
    }

    function showLogModal(log) {
        modalMetaGrid.innerHTML = `
            <div class="modal-meta-item">
                <span class="modal-meta-k">Log ID:</span>
                <span class="modal-meta-v">${escapeHtml(log.id)}</span>
            </div>
            <div class="modal-meta-item">
                <span class="modal-meta-k">Direction:</span>
                <span class="modal-meta-v">${escapeHtml((log.direction || "").toUpperCase())}</span>
            </div>
            <div class="modal-meta-item">
                <span class="modal-meta-k">Timestamp:</span>
                <span class="modal-meta-v">${escapeHtml(log.timestamp)}</span>
            </div>
            <div class="modal-meta-item">
                <span class="modal-meta-k">Findings Count:</span>
                <span class="modal-meta-v">${escapeHtml(log.findingsCount)}</span>
            </div>
            <div class="modal-meta-item">
                <span class="modal-meta-k">InfoTypes:</span>
                <span class="modal-meta-v">${escapeHtml(log.findingTypes)}</span>
            </div>
            <div class="modal-meta-item">
                <span class="modal-meta-k">Destination Log:</span>
                <span class="modal-meta-v">${escapeHtml(log.logName || config.logName)}</span>
            </div>
        `;
        modalLogJson.textContent = JSON.stringify(log, null, 2);
        const url = logsExplorerUrl(log.requestId);
        if (modalLogsLink) {
            modalLogsLink.style.display = url ? "inline-flex" : "none";
            if (url) modalLogsLink.href = url;
        }
        logDetailModal.style.display = "flex";
    }

    // =========================================================================
    // Initialization Bootstrap
    // =========================================================================
    // Notice dismiss logic
    const disclaimerCloseBtn = $("disclaimerCloseBtn");
    const disclaimerPanel = $("disclaimerPanel");
    if (disclaimerCloseBtn && disclaimerPanel) {
        disclaimerCloseBtn.addEventListener("click", () => {
            disclaimerPanel.style.opacity = "0";
            setTimeout(() => disclaimerPanel.style.display = "none", 200);
        });
    }

    initTheme();
    initSplitter();
    initPromptControls();
    initExecution();
    initPresent();
    initAdminDrawer();
    initModals();
    loadConfig();

    // Initial fetch of background logs for KPIs
    loadAuditLogs();
});
