/**
 * Guided Tour engine - welcome chooser, 4-rectangle spotlight + coachmark, mission stepper,
 * checklist, completion detection and "What just happened?" explainer.
 * Generalised from the Model Armor (SMR) demo engine, which adapted the Coffee Shop demo's tour.
 *
 * Integration contract (provided by app.js; the app never depends on this file):
 *   window.demoApp       { loadScenario(id), run(), isRunning(), isArchOpen(), isAdminOpen(), closeArch(), closeAdmin(), lastResult() }
 *   'demo:ready'         facade available
 *   'demo:runresult'     detail = { ok, httpStatus, latencyMs, tokens, verdict, response, ..., scenarioId }
 * Scenario buttons carry data-scenario="<id>". Run button = #runBtn, result card = #resultCard.
 *
 * Missions are declarative (tour-missions.js). Step schema: see references/tour.md in the skill.
 */
import { MISSIONS, WELCOME, FINISH } from './tour-missions.js';

const SLUG = 'apigee-sdp-demo';
const STORE_KEY = `${SLUG}.tour.v1`;
const HIDE_WELCOME_KEY = `${SLUG}.tour.hideWelcome`;
const SEEN_KEY = `${SLUG}.tour.seenThisSession`;
const RUN_BTN = '#runBtn';
const RESULT_CARD = '#resultCard';
const VERDICT_LABEL = { allowed: 'Allowed', blocked: 'Blocked', error: 'Error' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const resolve = (v, ...args) => (typeof v === 'function' ? v(...args) : v);
const CLOSE_BTN = '<button type="button" class="tour-close" data-act="dismiss" title="Close (Esc)" aria-label="Close tour">×</button>';

/**
 * Render authored template HTML without innerHTML: parse with DOMParser, drop active content
 * (script/iframe/object/embed/style, on* handlers, javascript: URLs), then move nodes in.
 * TODO(security): mission copy is trusted, authored HTML. Never interpolate server/user data into
 * it without esc(); dynamic values in this file always go through esc().
 */
function renderHTML(el, html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.body.querySelectorAll('script,iframe,object,embed,style,link,meta').forEach((n) => n.remove());
  doc.body.querySelectorAll('*').forEach((n) => {
    [...n.attributes].forEach((a) => {
      if (/^on/i.test(a.name) || (/^(href|src|xlink:href)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) n.removeAttribute(a.name);
    });
  });
  el.replaceChildren(...doc.body.childNodes);
}

export class GuidedTour {
  constructor(app) {
    this.app = app;
    this.state = this.load();
    this.hint = '';
    this.mode = 'idle'; // idle | step | explainer | finished
    this.phase = 'pick'; // scenario steps: pick -> loaded -> running
    this.lastRun = null;
    this.build();
    this.bind();

    const forced = new URLSearchParams(window.location.search).get('tour');
    let seen = false, hidden = false;
    try { hidden = !!localStorage.getItem(HIDE_WELCOME_KEY); seen = !!sessionStorage.getItem(SEEN_KEY); } catch { /* storage unavailable */ }
    if (forced && forced !== '0') {
      const idx = MISSIONS.findIndex((m) => m.id === forced);
      if (idx >= 0) this.start(idx, !this.state.completed.length); else this.showWelcome();
    } else if (this.state.active) {
      this.showStep(); // resume an in-progress tour after reload
    } else if (forced !== '0' && !hidden && !seen) {
      this.showWelcome();
    }
  }

  // ------------------------------------------------------------------ state
  load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      return { active: !!s.active, mission: s.mission || 0, step: s.step || 0, completed: Array.isArray(s.completed) ? s.completed : [] };
    } catch { return { active: false, mission: 0, step: 0, completed: [] }; }
  }
  save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(this.state)); } catch { /* storage unavailable */ } }
  get mission() { return MISSIONS[this.state.mission]; }
  get step() { return this.mission?.steps[this.state.step]; }
  stepTarget(s) { return s?.target || (s?.scenario ? `[data-scenario="${s.scenario}"]` : null); }

  // ------------------------------------------------------------------ DOM
  build() {
    const main = MISSIONS.filter((m) => !m.bonus).length;
    const W = WELCOME || {};
    const root = document.createElement('div');
    root.className = 'tour-root';
    renderHTML(root, `
      <div class="tour-welcome-backdrop" id="tourWelcome" hidden>
        <div class="tour-welcome" role="dialog" aria-modal="true" aria-labelledby="tourWelcomeTitle">
          <div class="tour-welcome-icon">${esc(W.icon || '🗺️')}</div>
          <h2 id="tourWelcomeTitle">${esc(W.title || 'Welcome')}</h2>
          <p class="tour-welcome-sub">${esc(W.subtitle || '')}</p>
          <div class="tour-choice-grid">
            <button type="button" class="tour-choice selected" data-choice="tour">
              <span class="tour-choice-badge">Recommended</span>
              <span class="tour-choice-icon">🗺️</span>
              <span class="tour-choice-title">Guided Tour</span>
              <span class="tour-choice-meta">${main} short missions${MISSIONS.length > main ? ' + bonus' : ''} · about ${esc(W.minutes || 5)} min</span>
              <ul class="tour-choice-list">${(W.bullets || []).map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
            </button>
            <button type="button" class="tour-choice" data-choice="explore">
              <span class="tour-choice-icon">🧭</span>
              <span class="tour-choice-title">Explore on my own</span>
              <span class="tour-choice-meta">Go straight to the scenarios. You can start the tour later from the header.</span>
            </button>
          </div>
          <div class="tour-welcome-footer">
            <label class="tour-check"><input type="checkbox" id="tourHideWelcome"> Don't show this again</label>
            <div class="tour-welcome-actions">
              <button type="button" class="tour-btn tour-btn-text" id="tourResumeBtn" hidden></button>
              <button type="button" class="tour-btn tour-btn-text" id="tourSkipBtn">Skip</button>
              <button type="button" class="tour-btn tour-btn-primary" id="tourStartBtn">Start Guided Tour</button>
            </div>
          </div>
        </div>
      </div>
      <div class="tour-dim" id="tourDim" hidden><i></i><i></i><i></i><i></i></div>
      <div class="tour-spotlight" id="tourSpotlight" hidden></div>
      <div class="tour-stepper" id="tourStepper" hidden>
        <button type="button" class="tour-stepper-list" id="tourChecklistBtn" title="Show all missions">☰ Missions</button>
        <div class="tour-dots" id="tourDots"></div>
        <span class="tour-stepper-label" id="tourStepperLabel"></span>
        <button type="button" class="tour-btn tour-btn-text tour-exit" id="tourExitBtn">Exit tour</button>
      </div>
      <div class="tour-checklist" id="tourChecklist" hidden></div>
      <div class="tour-pop" id="tourPop" role="dialog" aria-live="polite" aria-label="Guided tour step" hidden></div>
      <aside class="tour-explainer" id="tourExplainer" aria-live="polite" aria-label="What just happened" hidden></aside>
      <div class="tour-toast" id="tourToast" role="status" hidden></div>
    `);
    document.body.appendChild(root);
    const $ = (id) => root.querySelector(`#${id}`);
    Object.assign(this, {
      root, welcome: $('tourWelcome'), spot: $('tourSpotlight'), dim: $('tourDim'), stepper: $('tourStepper'),
      dots: $('tourDots'), stepperLabel: $('tourStepperLabel'), checklist: $('tourChecklist'),
      pop: $('tourPop'), explainer: $('tourExplainer'), toast: $('tourToast'),
    });

    let choice = 'tour';
    root.querySelectorAll('.tour-choice').forEach((btn) => btn.addEventListener('click', () => {
      choice = btn.dataset.choice;
      root.querySelectorAll('.tour-choice').forEach((b) => b.classList.toggle('selected', b === btn));
      $('tourStartBtn').textContent = choice === 'tour' ? 'Start Guided Tour' : 'Start exploring';
    }));
    this.closeWelcome = () => {
      try {
        if ($('tourHideWelcome').checked) localStorage.setItem(HIDE_WELCOME_KEY, '1');
        sessionStorage.setItem(SEEN_KEY, '1');
      } catch { /* storage unavailable */ }
      this.welcome.hidden = true;
    };
    $('tourStartBtn').addEventListener('click', () => {
      this.closeWelcome();
      if (choice === 'tour') this.start(0, true); else this.exit(false);
    });
    $('tourSkipBtn').addEventListener('click', () => { this.closeWelcome(); this.exit(false); });
    $('tourResumeBtn').addEventListener('click', () => { this.closeWelcome(); this.start(this.state.mission); });
    $('tourExitBtn').addEventListener('click', () => this.exit(true));
    $('tourChecklistBtn').addEventListener('click', () => this.toggleChecklist());
  }

  bind() {
    window.addEventListener('demo:runresult', (e) => this.onRunResult(e.detail || {}));
    document.addEventListener('click', (e) => {
      if (this.mode !== 'step') return;
      const s = this.step;
      if (s?.done?.click && e.target.closest(s.done.click)) { setTimeout(() => this.completeStep(), 300); return; }
      // The user picked the scenario chip themselves.
      if (s?.kind === 'scenario' && this.phase === 'pick' && e.target.closest(`[data-scenario="${s.scenario}"]`)) {
        this.phase = 'loaded';
        this.hint = 'Scenario loaded. Press <b>Run</b> here or the blue <b>Send</b> button.';
        setTimeout(() => { this.renderPop(); this.position(); }, 50);
        return;
      }
      // The user pressed the real Run button during a scenario / run step.
      const runBtn = e.target.closest(RUN_BTN);
      if (runBtn && !runBtn.disabled && (s?.kind === 'scenario' || s?.done?.run || s?.done?.verdict)) {
        this.phase = 'running';
        this.hint = 'Calling Apigee… watch the result panel.';
        this.renderPop();
        setTimeout(() => this.position(), 50);
      }
    }, true);
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!this.checklist.hidden) { this.toggleChecklist(false); e.stopImmediatePropagation(); return; }
      if (!this.welcome.hidden) { this.closeWelcome(); this.exit(false); e.stopImmediatePropagation(); return; }
      if (this.app.isArchOpen?.() || this.app.isAdminOpen?.()) return; // let the app close its own layer first
      if (['step', 'explainer', 'finished'].includes(this.mode)) this.dismiss();
    }, true);

    let raf = 0;
    const reflow = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => this.position()); };
    window.addEventListener('resize', reflow);
    window.addEventListener('scroll', reflow, true);
    // Panels resize (splitter, response text); keep the spotlight glued on.
    setInterval(() => { if (this.mode === 'step') this.position(); }, 300);
  }

  // ------------------------------------------------------------------ helpers
  showToast(html) {
    renderHTML(this.toast, html);
    this.toast.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { this.toast.hidden = true; }, 5000);
  }
  closeOverlays() { this.app.closeArch?.(); this.app.closeAdmin?.(); }

  // ------------------------------------------------------------------ flow
  showWelcome() {
    const resume = this.root.querySelector('#tourResumeBtn');
    const canResume = this.state.completed.length > 0 && this.state.mission < MISSIONS.length;
    resume.hidden = !canResume;
    if (canResume) resume.textContent = `Resume (Mission ${this.state.mission + 1})`;
    this.mode = 'idle';
    this.hideOverlays();
    this.welcome.hidden = false;
    this.root.querySelector('#tourStartBtn').focus();
  }

  /** Public: (re)open the chooser, e.g. from the header button. */
  open() { this.showWelcome(); }

  start(missionIdx = 0, fresh = false) {
    if (fresh) this.state = { active: true, mission: 0, step: 0, completed: [] };
    this.state.active = true;
    this.state.mission = Math.max(0, Math.min(missionIdx, MISSIONS.length - 1));
    this.state.step = 0;
    this.save();
    this.showStep();
  }

  exit(confirmed) {
    this.state.active = false;
    this.save();
    this.mode = 'idle';
    this.hideOverlays();
    if (confirmed) this.showToast('🗺️ Guided Tour paused. Reopen it any time from <b>Guided Tour</b> in the header.');
  }

  hideOverlays() {
    [this.dim, this.spot, this.stepper, this.checklist, this.pop, this.explainer].forEach((el) => { el.hidden = true; });
  }

  showStep() {
    const s = this.step;
    if (!s) return this.finish();
    this.mode = 'step';
    this.hint = '';
    this.phase = 'pick';
    this.explainer.hidden = true;
    if (s.before) s.before(this);
    this.renderStepper();
    this.renderPop();
    const sel = this.stepTarget(s);
    const el = sel && document.querySelector(sel);
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    setTimeout(() => this.position(), 350);
  }

  completeStep() {
    if (this.mode !== 'step') return;
    const m = this.mission;
    if (this.state.step < m.steps.length - 1) {
      this.state.step += 1;
      this.save();
      return this.showStep();
    }
    if (!this.state.completed.includes(m.id)) this.state.completed.push(m.id);
    this.save();
    this.showExplainer();
  }

  nextMission() {
    this.closeOverlays();
    if (this.state.mission >= MISSIONS.length - 1) return this.finish();
    this.state.mission += 1;
    this.state.step = 0;
    this.save();
    this.showStep();
  }

  back() {
    let mi = this.state.mission, si = this.state.step - 1;
    if (si < 0) {
      if (mi === 0) return;
      mi -= 1;
      si = MISSIONS[mi].steps.length - 1;
    }
    this.state.mission = mi;
    this.state.step = si;
    this.save();
    this.showStep();
  }

  finish() {
    this.state.active = false;
    this.state.mission = MISSIONS.length;
    this.save();
    this.hideOverlays();
    this.closeOverlays();
    const done = this.state.completed.length;
    const F = FINISH || {};
    renderHTML(this.explainer, `${CLOSE_BTN}
      <div class="tour-exp-head"><span class="tour-exp-kicker">Guided Tour</span><h3>🎉 Tour complete</h3></div>
      <p class="tour-exp-text">You finished <b>${done}</b> of ${MISSIONS.length} missions. ${esc(F.lead || "You've seen Apigee:")}</p>
      <ul class="tour-exp-summary">${(F.bullets || []).map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
      <div class="tour-exp-actions">
        <button type="button" class="tour-btn tour-btn-text" data-act="restart">Restart tour</button>
        <button type="button" class="tour-btn tour-btn-primary" data-act="close">Continue exploring</button>
      </div>`);
    this.mode = 'finished';
    this.explainer.classList.remove('tour-explainer-low');
    this.explainer.hidden = false;
    this.explainer.querySelector('[data-act="restart"]').onclick = () => this.start(0, true);
    this.explainer.querySelectorAll('[data-act="close"], [data-act="dismiss"]').forEach((b) => {
      b.onclick = () => { this.explainer.hidden = true; this.mode = 'idle'; };
    });
  }

  // ------------------------------------------------------------------ events
  onRunResult(detail) {
    this.lastRun = detail;
    if (!this.state.active || this.mode !== 'step') return;
    const s = this.step;
    const wantsVerdict = Array.isArray(s?.done?.verdict);
    const wantsRun = typeof s?.done?.run === 'function';
    if (!wantsVerdict && !wantsRun) return;
    if (s.scenario && detail.scenarioId && detail.scenarioId !== s.scenario && !s.anyScenario) {
      this.phase = 'pick';
      this.hint = `That ran <code>${esc(detail.scenarioId)}</code>. Load the highlighted scenario for this step.`;
      this.renderPop(); this.position();
      return;
    }
    const ok = (wantsVerdict ? s.done.verdict.includes(detail.verdict) : true) && (wantsRun ? !!s.done.run(detail, this) : true);
    if (ok) { setTimeout(() => this.completeStep(), 900); return; }
    this.phase = s.kind === 'scenario' ? 'loaded' : 'pick';
    const got = `<b>${esc(VERDICT_LABEL[detail.verdict] || detail.verdict)}</b>${detail.httpStatus ? ` (HTTP ${esc(detail.httpStatus)})` : ''}`;
    this.hint = (s.onMiss && s.onMiss(detail, this)) || `Got ${got}. Expected something else. Check the server config, then run it again.`;
    this.renderPop();
    this.position();
  }

  // ------------------------------------------------------------------ render
  renderStepper() {
    const main = MISSIONS.filter((m) => !m.bonus);
    renderHTML(this.dots, MISSIONS.map((m, i) => {
      const cls = this.state.completed.includes(m.id) ? 'done' : (i === this.state.mission ? 'current' : '');
      const label = m.bonus ? '★' : i + 1;
      return `${i ? '<span class="tour-dot-line"></span>' : ''}<button type="button" class="tour-dot ${cls} ${m.bonus ? 'bonus' : ''}" data-idx="${i}" title="${esc(m.title)}" aria-label="Mission ${i + 1}: ${esc(m.title)}">${cls === 'done' ? '✓' : label}</button>`;
    }).join(''));
    this.dots.querySelectorAll('.tour-dot').forEach((d) => d.addEventListener('click', () => this.start(Number(d.dataset.idx))));
    const m = this.mission;
    this.stepperLabel.textContent = m?.bonus ? 'Guided Tour · Bonus mission' : `Guided Tour · Mission ${this.state.mission + 1}/${main.length}`;
    const header = document.querySelector('header');
    if (header) this.stepper.style.top = `${Math.round(header.getBoundingClientRect().bottom) + 6}px`;
    this.stepper.hidden = false;
  }

  toggleChecklist(force) {
    const show = force ?? this.checklist.hidden;
    if (!show) { this.checklist.hidden = true; return; }
    const doneCount = this.state.completed.length;
    const pct = Math.round((doneCount / MISSIONS.length) * 100);
    renderHTML(this.checklist, `
      <div class="tour-cl-head">
        <div class="tour-ring" style="--pct:${pct}"><span>${doneCount}/${MISSIONS.length}</span></div>
        <div><div class="tour-cl-title">Mission checklist</div><div class="tour-cl-sub">Click a mission to jump to it</div></div>
      </div>
      <ol class="tour-cl-list">
        ${MISSIONS.map((m, i) => {
          const st = this.state.completed.includes(m.id) ? 'done' : (i === this.state.mission ? 'current' : 'todo');
          return `<li class="${st}" data-idx="${i}" tabindex="0"><span class="tour-cl-mark">${st === 'done' ? '✓' : (m.bonus ? '★' : i + 1)}</span>
            <span class="tour-cl-name">${esc(m.title)}</span><span class="tour-cl-badge">${esc(m.badge || '')}</span></li>`;
        }).join('')}
      </ol>`);
    this.checklist.querySelectorAll('li').forEach((li) => {
      const go = () => { this.toggleChecklist(false); this.start(Number(li.dataset.idx)); };
      li.addEventListener('click', go);
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
    this.checklist.hidden = false;
  }

  renderPop() {
    const s = this.step, m = this.mission;
    if (!s) return;
    const multi = m.steps.length > 1;
    const kicker = `${m.bonus ? 'BONUS MISSION' : `MISSION ${this.state.mission + 1} OF ${MISSIONS.filter((x) => !x.bonus).length}`}${multi ? ` · STEP ${this.state.step + 1}/${m.steps.length}` : ''}`;

    let primary = '';
    if (this.phase === 'running' && (s.kind === 'scenario' || s.done?.run || s.done?.verdict)) primary = '<button type="button" class="tour-btn tour-btn-primary" disabled>Running…</button>';
    else if (s.kind === 'scenario' && this.phase === 'loaded') primary = '<button type="button" class="tour-btn tour-btn-primary" data-act="run">Run ⚡</button>';
    else if (s.kind === 'scenario') primary = '<button type="button" class="tour-btn tour-btn-primary" data-act="load">Load this scenario</button>';
    else if (s.action) primary = `<button type="button" class="tour-btn tour-btn-primary" data-act="action">${esc(resolve(s.action.label, this))}</button>`;

    renderHTML(this.pop, `${CLOSE_BTN}
      <span class="tour-pop-arrow"></span>
      <div class="tour-pop-kicker">${kicker}</div>
      <h3 class="tour-pop-title">${esc(resolve(s.title, this))}</h3>
      <div class="tour-pop-body">${resolve(s.body, this) || ''}</div>
      ${s.expect ? `<div class="tour-expect">Expected: <b>${esc(resolve(s.expect, this))}</b></div>` : ''}
      ${this.hint ? `<div class="tour-hint">${this.hint}</div>` : ''}
      <div class="tour-pop-actions">
        <button type="button" class="tour-btn tour-btn-text" data-act="back" ${this.state.mission === 0 && this.state.step === 0 ? 'disabled' : ''}>Back</button>
        <button type="button" class="tour-btn tour-btn-text" data-act="skip">Skip</button>
        ${primary}
      </div>`);
    this.pop.hidden = false;

    const on = (act, fn) => { const b = this.pop.querySelector(`[data-act="${act}"]`); if (b) b.onclick = fn; };
    on('load', () => {
      if (!this.app.loadScenario(s.scenario)) { this.hint = `Scenario <code>${esc(s.scenario)}</code> is not in /api/config.`; this.renderPop(); return; }
      this.phase = 'loaded';
      this.hint = 'Prompt is set. Press <b>Run</b> here or the blue <b>Send</b> button.';
      this.renderPop(); this.position();
    });
    on('run', () => document.querySelector(RUN_BTN)?.click());
    on('action', () => s.action.run(this));
    on('skip', () => this.completeStep());
    on('back', () => this.back());
    on('dismiss', () => this.dismiss());
  }

  showExplainer() {
    const m = this.mission, ex = resolve(m.explainer, this) || {};
    this.mode = 'explainer';
    this.spot.hidden = true; this.dim.hidden = true;
    this.pop.hidden = true;
    this.renderStepper();
    const next = MISSIONS[this.state.mission + 1];
    const icon = { ok: '✓', fail: '✕', skip: '–', miss: '!' };
    const ho = ex.handoff;
    const handoff = ho ? `
      <div class="tour-handoff">
        <div class="tour-handoff-row">
          <span class="tour-handoff-layer missed"><span class="tour-handoff-x">✕</span>${esc(ho.missed)}<small>missed it</small></span>
          <span class="tour-handoff-arrow" aria-hidden="true">→</span>
          <span class="tour-handoff-layer caught"><span class="tour-handoff-x">🛡</span>${esc(ho.caught)}<small>blocked it</small></span>
        </div>
        <p class="tour-handoff-text">${esc(ho.text)}</p>
      </div>` : '';
    renderHTML(this.explainer, `${CLOSE_BTN}
      <div class="tour-exp-head"><span class="tour-exp-kicker">What just happened?</span><h3>${esc(ex.title || m.title)}</h3></div>
      ${handoff}
      <ol class="tour-flow">
        ${(ex.flow || []).map((f, i) => `<li class="${esc(f.state || 'ok')}"><span class="tour-flow-n">${icon[f.state] || i + 1}</span><span class="tour-flow-text">${esc(f.text)}</span>${f.tag ? `<span class="tour-flow-tag">${esc(f.tag)}</span>` : ''}</li>`).join('')}
      </ol>
      ${ex.note ? `<p class="tour-exp-note">${ex.note}</p>` : ''}
      <div class="tour-exp-done">Mission complete!</div>
      <div class="tour-exp-actions">
        ${next?.bonus ? '<button type="button" class="tour-btn tour-btn-text" data-act="finish">Finish tour</button>' : '<button type="button" class="tour-btn tour-btn-text" data-act="later">Pause</button>'}
        <button type="button" class="tour-btn tour-btn-primary" data-act="next">${next ? `${next.bonus ? 'Bonus' : 'Next'}: ${esc(next.title.replace(/^Bonus:\s*/, ''))}` : 'Finish tour'}</button>
      </div>`);
    this.explainer.hidden = false;
    this.explainer.classList.toggle('tour-explainer-low', !!this.app.isArchOpen?.());
    const on = (act, fn) => { const b = this.explainer.querySelector(`[data-act="${act}"]`); if (b) b.onclick = fn; };
    on('next', () => { this.explainer.hidden = true; this.nextMission(); });
    on('finish', () => this.finish());
    on('later', () => this.dismiss());
    on('dismiss', () => this.dismiss());
    this.explainer.querySelector('[data-act="next"]')?.focus();
  }

  /** Close the current tour pop-up (× or Esc). Progress is kept for Resume. */
  dismiss() {
    if (this.mode === 'step') return this.exit(true);
    if (this.mode === 'explainer') {
      this.state.mission = Math.min(this.state.mission + 1, MISSIONS.length - 1);
      this.state.step = 0;
      return this.exit(true);
    }
    if (this.mode === 'finished') { this.explainer.hidden = true; this.mode = 'idle'; }
  }

  // ------------------------------------------------------------------ layout
  position() {
    if (this.mode !== 'step' || this.pop.hidden) return;
    const s = this.step;
    const isVisible = (rect) => rect && rect.width > 0 && rect.height > 0 && rect.bottom > 0
      && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
    // Scenario steps: chip -> Run button (loaded) -> result card (running). No dimming once the
    // user is expected to act or watch, so the UI stays fully usable.
    let sel = this.stepTarget(s);
    let shade = s?.shade !== false;
    if (s?.kind === 'scenario' && this.phase === 'loaded') { sel = RUN_BTN; shade = false; }
    if (this.phase === 'running') { sel = RESULT_CARD; shade = false; }
    const el = sel ? document.querySelector(sel) : null;
    const r = el?.getBoundingClientRect();
    const visible = isVisible(r);

    const pw = this.pop.offsetWidth, ph = this.pop.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight, gap = 16, pad = 12;
    this.pop.classList.remove('place-right', 'place-left', 'place-bottom', 'place-top', 'place-center');

    if (!visible) {
      this.spot.hidden = true; this.dim.hidden = true;
      this.pop.classList.add('place-center');
      this.pop.style.left = `${(vw - pw) / 2}px`;
      this.pop.style.top = `${Math.max(80, (vh - ph) / 2)}px`;
      return;
    }

    const p = 6;
    // Clip the highlight to the viewport (the result card can be taller than the screen).
    const top0 = Math.max(4, r.top - p), bot0 = Math.min(vh - 4, r.bottom + p);
    Object.assign(this.spot.style, { left: `${r.left - p}px`, top: `${top0}px`, width: `${r.width + p * 2}px`, height: `${bot0 - top0}px` });
    this.spot.hidden = false;
    if (!shade) {
      this.dim.hidden = true;
    } else {
      // 4 rectangles around the hole (pointer-events:none) so the real UI stays clickable.
      const t = Math.max(0, r.top - p), b = Math.min(vh, r.bottom + p);
      const l = Math.max(0, r.left - p), rt = Math.min(vw, r.right + p);
      const [dTop, dBottom, dLeft, dRight] = this.dim.children;
      Object.assign(dTop.style, { left: '0px', top: '0px', width: `${vw}px`, height: `${t}px` });
      Object.assign(dBottom.style, { left: '0px', top: `${b}px`, width: `${vw}px`, height: `${Math.max(0, vh - b)}px` });
      Object.assign(dLeft.style, { left: '0px', top: `${t}px`, width: `${l}px`, height: `${Math.max(0, b - t)}px` });
      Object.assign(dRight.style, { left: `${rt}px`, top: `${t}px`, width: `${Math.max(0, vw - rt)}px`, height: `${Math.max(0, b - t)}px` });
      this.dim.hidden = false;
    }

    const a = { left: r.left, right: r.right, top: Math.max(r.top, 0), bottom: Math.min(r.bottom, vh) };
    a.height = a.bottom - a.top; a.width = r.width;
    let place, left, top;
    if (a.right + gap + pw < vw - pad) { place = 'right'; left = a.right + gap; top = a.top + a.height / 2 - ph / 2; }
    else if (a.left - gap - pw > pad) { place = 'left'; left = a.left - gap - pw; top = a.top + a.height / 2 - ph / 2; }
    else if (a.bottom + gap + ph < vh - pad) { place = 'bottom'; top = a.bottom + gap; left = a.left + a.width / 2 - pw / 2; }
    else { place = 'top'; top = a.top - gap - ph; left = a.left + a.width / 2 - pw / 2; }

    const minTop = this.stepper.hidden ? pad : Math.max(pad, this.stepper.getBoundingClientRect().bottom + 8);
    left = Math.max(pad, Math.min(left, vw - pw - pad));
    top = Math.max(minTop, Math.min(top, vh - ph - pad));
    this.pop.classList.add(`place-${place}`);
    this.pop.style.left = `${left}px`;
    this.pop.style.top = `${top}px`;
    const arrow = this.pop.querySelector('.tour-pop-arrow');
    if (arrow) {
      if (place === 'right' || place === 'left') {
        arrow.style.top = `${Math.max(16, Math.min(ph - 16, a.top + a.height / 2 - top))}px`; arrow.style.left = '';
      } else {
        arrow.style.left = `${Math.max(16, Math.min(pw - 16, a.left + a.width / 2 - left))}px`; arrow.style.top = '';
      }
    }
  }
}

// Bootstrap once app.js has exposed window.demoApp (module scripts run before DOMContentLoaded).
function boot() {
  if (window.demoTour || !window.demoApp || !MISSIONS.length) return;
  window.demoTour = new GuidedTour(window.demoApp);
  document.getElementById('headerTourBtn')?.addEventListener('click', () => window.demoTour.open());
}
if (window.demoApp) boot(); else window.addEventListener('demo:ready', boot, { once: true });
