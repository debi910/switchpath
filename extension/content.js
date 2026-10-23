// SwitchPath content script: one-switch scanning over the live page.
//
// Every visible clickable element (plus scroll, back, home, goal and pause)
// gets a probability from page heuristics, this user's history on the site and
// a free-tier model's prediction. The choices are arranged into the scan tree
// that minimizes expected steps (core/tree.js), and the highlight walks that
// tree: press the switch on a group to enter it, on an element to use it.
//
// Also runs on the extension's own home page (home.html), which replaces the
// New Tab page so a switch user never lands on a page they can't scan.

(() => {
  if (window.__switchpath) return;
  window.__switchpath = true;
  const SP = globalThis.SwitchPath;

  const DEFAULTS = {
    switchKey: 'Space',
    nextKey: '', // set for two-switch step scanning (no timer)
    scanMs: 1100,
    graceMs: 150, // presses this soon after the highlight moves count for the previous choice
    debounceMs: 300, // presses this soon after a choice are ignored (tremor, double hits)
    holdMs: 2000, // holding the switch this long pauses, resumes or starts scanning
    adaptive: true, // slow down after late presses and misses, speed up when picks are easy
    speak: false, // read each highlight aloud (auditory scanning)
    color: 'amber',
    order: 'coherent',
    laps: 2,
    autoStart: true,
    useModel: true,
    noAiSites: '',
  };
  const COLORS = { amber: '#ffb000', cyan: '#00d5ff', magenta: '#ff4fd8', lime: '#9dff3a' };
  const ACTIONS = [
    { id: 'down', label: 'Scroll down', icon: '↓', prior: 0.08 },
    { id: 'up', label: 'Scroll up', icon: '↑', prior: 0.02 },
    { id: 'back', label: 'Back', icon: '←', prior: 0.03 },
    { id: 'go', label: 'Go to site or search', icon: '⌕', prior: 0.012 },
    { id: 'home', label: 'Home', icon: '⌂', prior: 0.006 },
    { id: 'goal', label: 'Tell AI my goal', icon: '✦', prior: 0.01 },
    { id: 'pause', label: 'Pause', icon: 'Ⅱ', prior: 0.004 },
  ];
  const SELECTOR = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary',
    '[role=button]', '[role=link]', '[role=tab]', '[role=menuitem]', '[role=checkbox]', '[role=radio]',
    '[role=option]', '[role=switch]', '[role=combobox]', '[role=searchbox]', '[role=textbox]',
    '[contenteditable=""]', '[contenteditable=true]', '[onclick]', '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  // Clickables whose insides are one choice, not many.
  const ATOMIC = 'a[href],button,summary,[role=button],[role=link],[role=option],[role=menuitem],[role=tab]';
  const HOME_URL = chrome.runtime.getURL('home.html');
  const onHome = location.href.startsWith(HOME_URL);

  const cfg = { ...DEFAULTS };
  const S = {
    on: false,
    paused: false,
    mode: 'page', // page | keyboard | select
    items: [],
    tree: null,
    stack: [],
    timer: null,
    goal: '',
    llm: null, // label -> probability from the model
    llmModel: '',
    llmAt: 0,
    aiState: 'off', // off | waiting | ok | error | private
    rebuildPending: false,
    downAt: 0,
    advancedAt: 0,
    chosenAt: 0,
    kb: null, // {target, text, kind: 'field'|'goal'|'url', aiSugg: []}
    last: null,
    recent: [], // last picks for speed adaptation: {late, miss, frac}
    misses: 0,
  };

  // ---------- overlay (shadow DOM so page styles can't touch it) ----------
  const host = document.createElement('switchpath-overlay');
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>
    :host { all: initial; --hl: #ffb000; --ease-out: cubic-bezier(0.23, 1, 0.32, 1); }
    * { box-sizing: border-box; }
    .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; }
    .mask { position: fixed; inset: 0; width: 100vw; height: 100vh; }
    .ring { position: fixed; border-radius: 8px; box-shadow: 0 0 0 2px #000, 0 0 0 5px var(--hl), 0 0 0 7px #000; }
    .ring.flash { animation: flash 180ms var(--ease-out); }
    @keyframes flash { from { background: color-mix(in srgb, var(--hl) 45%, transparent); } to { background: transparent; } }
    .sib { position: fixed; border-radius: 6px; outline: 1.5px solid color-mix(in srgb, var(--hl) 55%, transparent); outline-offset: 2px; }
    .badge { position: fixed; display: flex; flex-direction: column; gap: 3px; max-width: 360px;
      font: 600 14px/1.25 system-ui, -apple-system, 'Segoe UI', sans-serif; background: #0d0f12; color: #fff;
      padding: 5px 9px 6px; border-radius: 7px; box-shadow: 0 4px 14px #0006; }
    .badge .t { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .badge .t b { color: var(--hl); font-weight: 700; }
    .timer { height: 3px; border-radius: 2px; background: #ffffff22; overflow: hidden; }
    .timer i { display: block; height: 100%; background: var(--hl); transform-origin: left; transform: scaleX(0); }
    .bar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483647; pointer-events: auto;
      background: rgba(13, 15, 18, 0.94); backdrop-filter: blur(10px); color: #f2f3f5;
      font: 15px/1.3 system-ui, -apple-system, 'Segoe UI', sans-serif; padding: 10px 12px 8px;
      display: flex; flex-direction: column; gap: 8px; border-top: 1px solid #ffffff1a; }
    .row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .btn { display: inline-flex; align-items: center; gap: 6px; border: 1.5px solid #ffffff24; border-radius: 9px;
      padding: 7px 12px; background: #1c1f25; color: #f2f3f5; font: inherit; font-weight: 500; min-width: 40px;
      justify-content: center; white-space: nowrap; }
    .btn .i { opacity: 0.75; font-size: 14px; }
    .btn.cur { background: var(--hl); color: #000; border-color: #000; box-shadow: 0 0 0 3px #000, 0 0 0 5px var(--hl); }
    .btn.cur .i { opacity: 1; }
    .btn.sibling { border-color: color-mix(in srgb, var(--hl) 60%, transparent); }
    .btn.picked { transform: scale(0.97); }
    .key { min-width: 44px; font-variant-numeric: tabular-nums; }
    .ai { border-color: #9b6bff88; } .ai .i { color: #b89bff; opacity: 1; }
    .sugg { border-color: #39c58a88; }
    .text { background: #fff; color: #000; padding: 8px 10px; border-radius: 8px; min-height: 38px; font-size: 18px; flex: 1;
      overflow-wrap: anywhere; }
    .label { font-size: 13px; color: #aab0bb; margin-right: 4px; }
    .status { display: flex; gap: 10px; align-items: center; font-size: 13px; color: #aab0bb; min-height: 22px; }
    .status .hint { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .dots { display: inline-flex; gap: 4px; } .dots i { width: 7px; height: 7px; border-radius: 50%; background: #ffffff30; }
    .dots i.on { background: var(--hl); }
    .chip { display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px; border-radius: 999px; background: #ffffff12;
      color: #dfe2e7; white-space: nowrap; max-width: 280px; overflow: hidden; text-overflow: ellipsis; }
    .chip .d { width: 7px; height: 7px; border-radius: 50%; background: #6b7280; flex-shrink: 0; }
    .chip .d.ok { background: #39c58a; } .chip .d.waiting { background: #e6b422; } .chip .d.error { background: #ef5350; }
    .chip.win { background: color-mix(in srgb, var(--hl) 18%, transparent); color: #fff; }
    .paused { font-size: 16px; color: #fff; }
    @media (prefers-reduced-motion: reduce) { .timer { display: none; } .ring.flash { animation: none; } }
    [hidden] { display: none !important; }
  </style>
  <div class="layer"></div>
  <div class="bar" hidden>
    <div class="row kbtext" hidden><span class="label"></span><div class="text"></div></div>
    <div class="row kbsugg" hidden></div>
    <div class="row kbkeys" hidden></div>
    <div class="row selopts" hidden></div>
    <div class="row actions"></div>
    <div class="status"><span class="dots"></span><span class="hint"></span><span class="chips"></span></div>
  </div>`;
  const $ = (s) => shadow.querySelector(s);
  const layer = $('.layer');
  const bar = $('.bar');
  for (const a of ACTIONS) {
    const b = button(a.label, a.icon);
    b.dataset.action = a.id;
    $('.actions').append(b);
  }

  function button(text, icon, cls = '') {
    const b = document.createElement('div');
    b.className = 'btn ' + cls;
    if (icon) {
      const i = document.createElement('span');
      i.className = 'i';
      i.textContent = icon;
      b.append(i);
    }
    b.append(document.createTextNode(text));
    return b;
  }

  // ---------- collecting choices ----------
  function visible(el, r) {
    if (r.width < 4 || r.height < 4) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || +cs.opacity < 0.05 || cs.display === 'none') return false;
    // Covered by something else (a modal, a sticky header, our own bar)?
    const x = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2));
    const y = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2));
    const top = document.elementFromPoint(x, y);
    return !!top && (top === el || el.contains(top) || top.contains(el));
  }

  function labelOf(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ').trim();
      if (t) return t;
    }
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
      const lab = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      const t = (lab && lab.innerText) || el.closest('label')?.innerText || el.placeholder || el.title || el.name || '';
      if (el.type === 'submit' || el.type === 'button') return el.value || t || 'Submit';
      return t.trim() || el.type || 'text box';
    }
    const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (t) return t.slice(0, 80);
    const img = el.querySelector('img[alt],svg[aria-label]');
    return (img && (img.alt || img.getAttribute('aria-label'))) || el.title || '';
  }

  function regionOf(el) {
    if (el.closest('nav,[role=navigation]')) return 'nav';
    if (el.closest('footer,[role=contentinfo]')) return 'footer';
    if (el.closest('header,[role=banner]')) return 'header';
    if (el.closest('aside,[role=complementary]')) return 'sidebar';
    if (el.closest('dialog,[role=dialog],[aria-modal=true]')) return 'dialog';
    return 'main';
  }

  function kindOf(el) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    if (isTextField(el)) return 'text box';
    if (tag === 'select') return 'dropdown';
    if (tag === 'a') return 'link';
    return role || (tag === 'input' ? el.type : tag);
  }

  function isTextField(el) {
    if (el.isContentEditable) return true;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') return !/^(submit|button|checkbox|radio|hidden|image|reset|file|range|color)$/i.test(el.type);
    return /^(textbox|searchbox|combobox)$/.test(el.getAttribute('role') || '');
  }

  function collect() {
    const chosen = new Set();
    const els = [];
    for (const el of document.querySelectorAll(SELECTOR)) {
      if (host.contains(el) || el.disabled || el.getAttribute('aria-hidden') === 'true') continue;
      const outer = el.parentElement && el.parentElement.closest(ATOMIC);
      if (outer && chosen.has(outer)) continue;
      const r = el.getBoundingClientRect();
      if (!visible(el, r)) continue;
      chosen.add(el);
      const d = {
        el,
        kind: kindOf(el),
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || '',
        type: el.getAttribute('type') || '',
        text: labelOf(el),
        name: el.getAttribute('name') || '',
        placeholder: el.getAttribute('placeholder') || '',
        href: el.getAttribute('href') || '',
        box: [r.left, r.top, r.width, r.height],
        viewport: [innerWidth, innerHeight],
        region: regionOf(el),
      };
      d.inNav = d.region === 'nav' || d.region === 'header';
      d.inFooter = d.region === 'footer';
      els.push(d);
      if (els.length >= 300) break;
    }
    return els;
  }

  // Web apps (mail, chat, feeds) often scroll an inner panel, not the page.
  // Find the scrollable element under the middle of the screen.
  function scroller() {
    const se = document.scrollingElement || document.documentElement;
    if (se.scrollHeight > innerHeight + 4) return se;
    let best = null;
    for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3]]) {
      let el = document.elementFromPoint(innerWidth * fx, innerHeight * fy);
      while (el && el !== document.body && el !== document.documentElement) {
        const oy = getComputedStyle(el).overflowY;
        if (/(auto|scroll|overlay)/.test(oy) && el.scrollHeight > el.clientHeight + 20) {
          const area = el.clientWidth * el.clientHeight;
          if (!best || area > best.area) best = { el, area };
          break;
        }
        el = el.parentElement;
      }
    }
    return best ? best.el : se;
  }

  function actionItems() {
    const out = [];
    const sc = scroller();
    const viewH = sc === document.scrollingElement || sc === document.documentElement ? innerHeight : sc.clientHeight;
    for (const a of ACTIONS) {
      const off =
        (a.id === 'down' && sc.scrollTop + viewH >= sc.scrollHeight - 4) ||
        (a.id === 'up' && sc.scrollTop <= 0) ||
        (a.id === 'back' && history.length <= 1) ||
        (a.id === 'home' && onHome);
      const node = shadow.querySelector(`[data-action=${a.id}]`);
      node.hidden = off;
      if (off) continue;
      out.push({ kind: 'action', id: a.id, text: a.label, prior: a.prior, node });
    }
    return out;
  }

  // ---------- history ----------
  const histKey = 'hist:' + (onHome ? 'home' : location.host);
  let hist = { site: {}, pages: {} };
  const pageKey = () => location.pathname.replace(/\d+/g, '#');

  async function loadHistory() {
    try {
      hist = (await chrome.storage.local.get(histKey))[histKey] || hist;
    } catch {}
  }

  function rememberPick(sig) {
    SP.recordPick(hist.site, sig);
    const pk = pageKey();
    SP.recordPick((hist.pages[pk] ||= {}), sig);
    const keys = Object.keys(hist.pages);
    if (keys.length > 200) delete hist.pages[keys[0]];
    chrome.storage.local.set({ [histKey]: hist }).catch(() => {});
  }

  // ---------- building the scan tree ----------
  function build() {
    const els = collect();
    const acts = actionItems();
    const heur = SP.heuristicProbs(els);
    const actMass = acts.reduce((a, x) => a + x.prior, 0);
    const base = [...heur.map((h) => h * (1 - actMass)), ...acts.map((a) => a.prior)];
    const items = [...els, ...acts];
    for (const it of items) it.sig = it.kind === 'action' ? 'action|' + it.id : SP.signature(it);
    let llm = null;
    if (S.llm) {
      llm = {};
      items.forEach((it, i) => {
        if (S.llm[it.text] != null) llm[i] = S.llm[it.text];
      });
    }
    const probs = SP.mix(base, items.map((it) => it.sig), {
      siteHistory: hist.site,
      pageHistory: hist.pages[pageKey()] || {},
      llm,
      llmWeight: S.goal ? 0.6 : 0.35,
    });
    items.forEach((it, i) => (it.p = probs[i]));
    S.items = items;
    // Actions sit in the bar below everything, so reading order puts them last.
    const boxes = items.map(boxOf);
    const reading = SP.readingOrderOf(boxes);
    S.tree = SP.buildTree(probs, { order: cfg.order, readingOrder: reading });
    S.reading = reading;
    S.rows = SP.rowsOf(boxes, reading);
    S.stack = [{ list: S.tree.children, i: -1, laps: 0 }];
    S.rebuildPending = false;
    askModel(items);
  }

  function boxOf(it) {
    if (it.node) {
      const r = it.node.getBoundingClientRect();
      return [r.left, r.top + 10000, r.width, r.height]; // after page content
    }
    return it.box;
  }

  // ---------- the model ----------
  // Never send a page with a password field, or a site the user excluded.
  function aiAllowed() {
    if (!cfg.useModel) return false;
    const host = location.hostname;
    const excluded = cfg.noAiSites.split(/[\s,]+/).filter(Boolean).some((s) => host === s || host.endsWith('.' + s));
    const secret = !!document.querySelector('input[type=password]');
    S.aiState = excluded || secret ? 'private' : S.aiState === 'private' ? 'off' : S.aiState;
    return !excluded && !secret;
  }

  let askTimer = null;
  function askModel(items) {
    if (!aiAllowed()) return;
    const labels = items.map((it) => it.text).join('\u0001');
    if (labels === S.askedFor) return;
    clearTimeout(askTimer);
    // Wait for the page to settle; at most one call every few seconds.
    const wait = Math.max(300, 3000 - (Date.now() - S.llmAt));
    askTimer = setTimeout(async () => {
      S.askedFor = labels;
      S.llmAt = Date.now();
      S.aiState = 'waiting';
      renderStatus();
      const elements = items.map((it, i) => ({ id: i, kind: it.kind, label: (it.text || '(no label)').slice(0, 80), region: it.region }));
      let r;
      try {
        r = await chrome.runtime.sendMessage({ type: 'rank', url: location.href, title: document.title, elements });
      } catch {
        return;
      }
      if (!S.on) return;
      if (!r || r.error) {
        S.aiState = r && r.error === 'off' ? 'off' : 'error';
        S.aiError = r && r.error;
        renderStatus();
        return;
      }
      S.aiState = 'ok';
      S.llm = {};
      for (const [i, p] of Object.entries(r.probs)) if (items[+i]) S.llm[items[+i].text] = p;
      S.llmModel = r.model;
      // Don't move things under the user mid-choice: apply at the next top.
      if (S.mode === 'page') {
        if (S.stack.length === 1 && S.stack[0].i <= 0) restart();
        else S.rebuildPending = true;
      }
      renderStatus();
    }, wait);
  }

  // ---------- scanning ----------
  function current() {
    const top = S.stack[S.stack.length - 1];
    return top && top.i >= 0 ? top.list[top.i] : null;
  }

  function restart() {
    if (S.mode === 'page') build();
    else if (S.mode === 'keyboard') buildKeyboard();
    schedule(true);
    draw();
  }

  function schedule(first = false) {
    clearTimeout(S.timer);
    if (!S.on || S.paused || cfg.nextKey) return;
    S.timer = setTimeout(() => {
      advance();
      schedule();
    }, first ? cfg.scanMs * 1.5 : cfg.scanMs);
  }

  function advance() {
    const top = S.stack[S.stack.length - 1];
    S.prev = { top, i: top.i, at: performance.now() };
    S.advancedAt = performance.now();
    top.i++;
    if (top.i >= top.list.length) {
      top.i = 0;
      top.laps++;
      if (S.stack.length > 1 && top.laps >= cfg.laps) {
        // Nothing chosen in this group: go back up. Counts as a miss.
        S.stack.pop();
        S.stack[S.stack.length - 1].i = 0;
        S.misses++;
      } else if (S.stack.length === 1 && S.rebuildPending) {
        restart();
        return;
      }
    }
    draw();
  }

  // A press that lands just after the highlight moved was meant for the
  // previous choice (reaction time), as in dedicated switch software.
  function pressTarget() {
    const top = S.stack[S.stack.length - 1];
    const p = S.prev;
    S.late = !!(p && p.top === top && p.i >= 0 && performance.now() - p.at < cfg.graceMs);
    S.pressI = S.late ? p.i : top ? top.i : null;
    S.pressFrac = Math.min(1, (performance.now() - S.advancedAt) / cfg.scanMs);
  }

  function choose() {
    const top = S.stack[S.stack.length - 1];
    if (S.pressI != null && top) top.i = S.pressI;
    S.pressI = null;
    S.prev = null;
    const node = current();
    if (!node) return;
    S.chosenAt = performance.now();
    flash(node);
    if (node.children) {
      S.stack.push({ list: node.children, i: 0, laps: 0 });
      draw();
      schedule(true);
      return;
    }
    const it = S.items[node.item];
    const steps = SP.stepsTo(S.tree, node.item);
    if (S.mode === 'page') {
      const rc = SP.rowColumnSteps(S.rows, node.item);
      const lin = SP.linearSteps(S.reading, node.item);
      S.last = { steps, rc, lin };
      logStats(steps, rc, lin);
      rememberPick(it.sig);
    }
    adaptSpeed();
    activate(it);
  }

  // Adaptive timing: presses that land late (inside the grace window) or
  // groups the user lets run out mean the scan is too fast for them today;
  // a run of quick, clean picks means it can go a little faster.
  function adaptSpeed() {
    S.recent.push({ late: S.late, miss: S.misses > 0, frac: S.pressFrac || 1 });
    S.misses = 0;
    S.recent = S.recent.slice(-10);
    if (!cfg.adaptive || cfg.nextKey) return;
    const trouble = S.recent.filter((r) => r.late || r.miss).length;
    let next = cfg.scanMs;
    if (trouble >= 3) next = Math.min(4000, Math.round(cfg.scanMs * 1.12));
    else if (S.recent.length === 10 && trouble === 0 && median(S.recent.map((r) => r.frac)) < 0.45) next = Math.max(450, Math.round(cfg.scanMs * 0.93));
    if (next !== cfg.scanMs) {
      const slower = next > cfg.scanMs;
      cfg.scanMs = next;
      S.recent = [];
      chrome.storage.local.set({ scanMs: next }).catch(() => {});
      setStatus(`${slower ? 'Slowed' : 'Sped'} the scan to ${(next / 1000).toFixed(2)} s per step`);
    }
  }

  const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

  async function logStats(steps, rc, lin) {
    try {
      const { stats = { picks: 0, steps: 0, rc: 0, lin: 0 } } = await chrome.storage.local.get('stats');
      stats.picks++;
      stats.steps += steps;
      stats.rc += rc;
      stats.lin += lin;
      await chrome.storage.local.set({ stats });
    } catch {}
  }

  // ---------- doing things ----------
  function activate(it) {
    if (it.kind === 'action') return doAction(it.id);
    if (it.kind === 'key') return pressKey(it);
    if (it.kind === 'option') return pickOption(it);
    const el = it.el;
    if (!el.isConnected) return restart();
    if (isTextField(el)) {
      el.focus();
      return openKeyboard({ kind: 'field', target: el, field: it.text });
    }
    if (el.tagName === 'SELECT') return openSelect(el);
    el.focus({ preventScroll: true });
    el.click();
    settleThenRestart();
  }

  function settleThenRestart(ms = 700) {
    S.stack = [{ list: [], i: -1, laps: 0 }];
    draw();
    clearTimeout(S.timer);
    setTimeout(() => S.on && restart(), ms);
  }

  function doAction(id) {
    const sc = scroller();
    const page = sc === document.scrollingElement || sc === document.documentElement;
    const step = (page ? innerHeight : sc.clientHeight) * 0.8;
    if (id === 'down') sc.scrollBy({ top: step, behavior: 'instant' });
    if (id === 'up') sc.scrollBy({ top: -step, behavior: 'instant' });
    if (id === 'back') history.back();
    if (id === 'home') location.href = HOME_URL;
    if (id === 'pause') return setPaused(true);
    if (id === 'goal') return openKeyboard({ kind: 'goal', field: 'Your goal', text: S.goal });
    if (id === 'go') return openKeyboard({ kind: 'url', field: 'Website or search', text: '' });
    settleThenRestart(id === 'back' || id === 'home' ? 900 : 250);
  }

  function setPaused(p) {
    S.paused = p;
    clearTimeout(S.timer);
    if (p) {
      S.stack = [{ list: [], i: -1, laps: 0 }];
      draw();
      speak(`Paused. Hold the switch for ${Math.round(cfg.holdMs / 1000)} seconds to resume.`);
    } else restart();
    renderStatus();
  }

  // ---------- dropdowns ----------
  function openSelect(sel) {
    S.mode = 'select';
    const row = $('.selopts');
    row.replaceChildren();
    row.hidden = false;
    const opts = [...sel.options].filter((o) => !o.disabled);
    const items = opts.map((o) => {
      const b = button(o.text, o.selected ? '✓' : '');
      row.append(b);
      return { kind: 'option', text: o.text, node: b, option: o, select: sel };
    });
    S.items = items;
    // Options are near-uniform; keep the current one cheapest to re-confirm.
    const probs = items.map((it) => (it.option.selected ? 3 : 1));
    S.tree = SP.buildTree(probs, { order: 'coherent' });
    S.stack = [{ list: S.tree.children, i: -1, laps: 0 }];
    bar.hidden = false;
    schedule(true);
    draw();
  }

  function pickOption(it) {
    it.select.value = it.option.value;
    it.select.dispatchEvent(new Event('input', { bubbles: true }));
    it.select.dispatchEvent(new Event('change', { bubbles: true }));
    $('.selopts').hidden = true;
    S.mode = 'page';
    settleThenRestart(400);
  }

  // ---------- keyboard ----------
  const LETTERS = 'etaoinshrdlucmfwypvbgkqjxz'.split('');
  const EXTRA = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '@', '-', ',', '/', '?'];
  const wordIndex = SP.WORDS.map((w, i) => [w, Math.exp(SP.WORD_LOGP[i])]);
  const KB_PROMPT = { goal: 'What do you want to do here?', url: 'Website or search:' };

  function openKeyboard(kb) {
    S.mode = 'keyboard';
    S.kb = { text: kb.kind === 'field' ? currentText(kb.target) : kb.text || '', aiSugg: [], ...kb };
    if (kb.kind === 'goal') S.kb.text = S.goal;
    $('.kbtext').hidden = $('.kbsugg').hidden = $('.kbkeys').hidden = false;
    $('.kbtext .label').textContent = KB_PROMPT[kb.kind] || `Typing into: ${kb.field}`;
    restart();
    askSuggestions();
  }

  function closeKeyboard() {
    S.mode = 'page';
    S.kb = null;
    $('.kbtext').hidden = $('.kbsugg').hidden = $('.kbkeys').hidden = true;
    settleThenRestart(300);
  }

  function currentText(el) {
    return el.isContentEditable ? el.innerText : el.value || '';
  }

  function setText(el, text) {
    if (el.isContentEditable) {
      el.focus();
      document.execCommand('selectAll');
      document.execCommand('insertText', false, text);
      return;
    }
    // React and friends track the native value setter.
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Letter probabilities come from the words that continue what's typed, so
  // after "th" the "e" is one step away and "q" is deep in the tree.
  function keyboardModel(text) {
    const prefix = (text.match(/[a-z']*$/i) || [''])[0].toLowerCase();
    const next = {};
    let wordEnd = 0;
    const completions = [];
    for (const [w, p] of wordIndex) {
      if (!w.startsWith(prefix)) continue;
      if (w.length === prefix.length) wordEnd += p;
      else {
        next[w[prefix.length]] = (next[w[prefix.length]] || 0) + p;
        if (completions.length < 3 && w.length > prefix.length + 1) completions.push([w, p]);
      }
    }
    return { prefix, next, wordEnd, completions };
  }

  function buildKeyboard() {
    const kb = S.kb;
    const m = keyboardModel(kb.text);
    const keys = [];
    const add = (label, kind, value, weight, icon = '') => keys.push({ kind: 'key', text: label, key: kind, value, w: weight, icon });
    const tot = Object.values(m.next).reduce((a, b) => a + b, 0) + m.wordEnd || 1;
    // Older suggestions stay only while they still match what was typed.
    // Older suggestions stay while they still match what was typed, so a
    // fifth guess from one letter ago can be the first one now.
    const lc = kb.text.toLowerCase();
    const shown = kb.aiSugg.filter((s) => s.toLowerCase().startsWith(lc) && s.length > kb.text.length).slice(0, 3);
    for (const s of shown) add(s, 'ai', s, 0.12, '✦');
    host.dataset.sugg = JSON.stringify(shown); // for tests
    for (const [w, p] of m.completions) add(w, 'word', w, (0.5 * p) / tot);
    add('space', 'char', ' ', m.prefix ? 0.08 + (0.5 * m.wordEnd) / tot : 0.01, '␣');
    for (const c of LETTERS) add(c, 'char', c, 0.004 + (0.6 * (m.next[c] || 0)) / tot);
    for (const c of EXTRA) add(c, 'char', c, kb.kind === 'url' && /[./]/.test(c) ? 0.02 : 0.002);
    add('delete', 'del', '', 0.03, '⌫');
    add(kb.kind === 'goal' ? 'save goal' : kb.kind === 'url' ? 'go' : 'enter', 'enter', '', kb.text.length > 2 ? 0.06 : 0.005, kb.kind === 'goal' ? '✓' : '⏎');
    add('close', 'close', '', 0.01, '✕');
    // Lay keys out: suggestions on top, keys below, in a fixed order so the
    // user's eyes learn where things are; the tree decides the grouping.
    const sugRow = $('.kbsugg');
    const keyRow = $('.kbkeys');
    sugRow.replaceChildren();
    keyRow.replaceChildren();
    for (const k of keys) {
      const sug = k.key === 'ai' || k.key === 'word';
      const b = button(k.text, k.icon, k.key === 'ai' ? 'ai' : k.key === 'word' ? 'sugg' : 'key');
      (sug ? sugRow : keyRow).append(b);
      k.node = b;
    }
    sugRow.hidden = !sugRow.children.length;
    $('.kbtext .text').textContent = kb.text + '▏';
    S.items = keys;
    S.tree = SP.buildTree(keys.map((k) => k.w), { order: 'fast' });
    S.stack = [{ list: S.tree.children, i: -1, laps: 0 }];
    S.rebuildPending = false;
  }

  function pressKey(k) {
    const kb = S.kb;
    if (k.key === 'close') return closeKeyboard();
    if (k.key === 'enter') {
      if (kb.kind === 'goal') {
        S.goal = kb.text.trim();
        chrome.runtime.sendMessage({ type: 'goal', goal: S.goal }).catch(() => {});
        S.llm = null;
        S.askedFor = '';
        S.llmAt = 0; // a new goal deserves a fresh ranking right away
        return closeKeyboard();
      }
      if (kb.kind === 'url') {
        const t = kb.text.trim();
        if (!t) return closeKeyboard();
        location.href = /^\S+\.[a-z]{2,}(\/\S*)?$/i.test(t) ? (/^https?:/i.test(t) ? t : 'https://' + t) : 'https://www.google.com/search?q=' + encodeURIComponent(t);
        return closeKeyboard();
      }
      const el = kb.target;
      for (const type of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      if (el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
      return closeKeyboard();
    }
    if (k.key === 'del') kb.text = kb.text.slice(0, -1);
    else if (k.key === 'char') kb.text += k.value;
    else if (k.key === 'word') kb.text = kb.text.replace(/[a-z']*$/i, '') + k.value + ' ';
    else if (k.key === 'ai') kb.text = k.value;
    if (kb.kind === 'field') setText(kb.target, kb.text);
    restart();
    askSuggestions();
  }

  let suggTimer = null;
  function askSuggestions() {
    const kb = S.kb;
    // Never suggest into password fields; respect the AI privacy rules.
    if (!kb || (kb.target && kb.target.type === 'password') || !aiAllowed()) return;
    clearTimeout(suggTimer);
    suggTimer = setTimeout(async () => {
      const typed = kb.text;
      const field = kb.kind === 'goal' ? 'a short description of what the user wants to do on this page' : kb.kind === 'url' ? 'a website address or a web search' : kb.field;
      let r;
      try {
        r = await chrome.runtime.sendMessage({ type: 'suggest', url: location.href, title: document.title, field, typed });
      } catch {
        return;
      }
      if (!r || r.error || S.kb !== kb || kb.text !== typed) return;
      kb.aiSugg = [...new Set([...r.suggestions, ...kb.aiSugg])];
      // Rebuild now if the user hasn't started moving through the keys,
      // otherwise when the scan next comes round to the top.
      if (S.stack.length === 1 && S.stack[0].i <= 0) restart();
      else S.rebuildPending = true;
    }, 150);
  }

  // ---------- drawing ----------
  function rectOf(it) {
    if (it.node) return it.node.getBoundingClientRect();
    if (it.el && it.el.isConnected) return it.el.getBoundingClientRect();
    const [x, y, w, h] = it.box;
    return { left: x, top: y, width: w, height: h };
  }

  const SVG = 'http://www.w3.org/2000/svg';

  function draw() {
    syncBar();
    layer.replaceChildren();
    for (const b of shadow.querySelectorAll('.btn.cur,.btn.sibling')) b.classList.remove('cur', 'sibling');
    const top = S.stack[S.stack.length - 1];
    renderDots();
    if (!S.on || !top || !top.list.length) {
      host.dataset.current = '';
      renderStatus();
      return;
    }
    const cur = current();
    const holes = [];
    let curRects = [];
    top.list.forEach((node) => {
      const leaves = node.children ? SP.leaves(node) : [node.item];
      const isCur = node === cur;
      for (const li of leaves) {
        const it = S.items[li];
        if (!it) continue;
        // At the top level everything is a sibling; outlining it all is noise.
        const showSib = S.stack.length > 1;
        if (it.node) {
          // Bar buttons sit above the overlay: style the button itself.
          if (isCur || showSib) it.node.classList.add(isCur ? 'cur' : 'sibling');
          if (isCur) curRects.push(it.node.getBoundingClientRect());
          continue;
        }
        const r = rectOf(it);
        if (isCur) {
          holes.push(r);
          curRects.push(r);
          const ring = document.createElement('div');
          ring.className = 'ring';
          place(ring, r, 4);
          layer.append(ring);
        } else if (showSib) {
          const sib = document.createElement('div');
          sib.className = 'sib';
          place(sib, r, 1);
          layer.append(sib);
        }
      }
    });
    // Spotlight: dim the page except the current choice, so it stands out
    // even for low vision, on any page colour.
    if (holes.length) {
      const svg = document.createElementNS(SVG, 'svg');
      svg.setAttribute('class', 'mask');
      const path = document.createElementNS(SVG, 'path');
      let d = `M0 0H${innerWidth}V${innerHeight}H0Z`;
      for (const r of holes) d += roundRect(r.left - 4, r.top - 4, r.width + 8, r.height + 8, 8);
      path.setAttribute('d', d);
      path.setAttribute('fill-rule', 'evenodd');
      path.setAttribute('fill', 'rgba(8,10,14,0.42)');
      svg.append(path);
      layer.prepend(svg);
    }
    if (cur) {
      const leaves = cur.children ? SP.leaves(cur) : [cur.item];
      const label = cur.children ? groupLabel(leaves) : S.items[cur.item].text || '(no label)';
      if (curRects.length) badge(label, cur.children ? leaves.length : 0, curRects);
      if (cur !== S.spokenNode) speak(cur.children ? `${leaves.length} choices. ${label}` : label);
      S.spokenNode = cur;
      // For automated tests and screen readers outside the closed shadow.
      host.dataset.current = cur.children ? `group:${leaves.length}` : S.items[cur.item].text;
      host.dataset.leaves = JSON.stringify(leaves.map((li) => S.items[li] && S.items[li].text));
    }
    host.dataset.depth = S.stack.length;
    host.dataset.mode = S.mode;
    renderStatus();
  }

  // Only the choices being scanned are shown in the bar.
  function syncBar() {
    $('.actions').hidden = S.mode !== 'page';
  }

  // A group is named by its most likely members, so the user knows what's inside.
  function groupLabel(leaves) {
    const named = leaves.map((li) => S.items[li]).filter((it) => it && it.text).sort((a, b) => (b.p || b.w || 0) - (a.p || a.w || 0));
    return named.slice(0, 2).map((it) => it.text.slice(0, 28)).join(', ') + (named.length > 2 ? '…' : '');
  }

  function place(el, r, pad) {
    Object.assign(el.style, { left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + 2 * pad + 'px', height: r.height + 2 * pad + 'px' });
  }

  function roundRect(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    return `M${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h - r}Q${x + w} ${y + h} ${x + w - r} ${y + h}H${x + r}Q${x} ${y + h} ${x} ${y + h - r}V${y + r}Q${x} ${y} ${x + r} ${y}Z`;
  }

  function badge(label, count, rects) {
    const b = document.createElement('div');
    b.className = 'badge';
    const t = document.createElement('div');
    t.className = 't';
    if (count) {
      const n = document.createElement('b');
      n.textContent = `${count} choices · `;
      t.append(n);
    }
    t.append(document.createTextNode(label));
    b.append(t);
    if (!cfg.nextKey && !S.paused) {
      const timer = document.createElement('div');
      timer.className = 'timer';
      const fill = document.createElement('i');
      timer.append(fill);
      b.append(timer);
      // Constant motion, so linear; it shows how long until the highlight moves.
      fill.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: S.stack.length && S.stack.at(-1).i === 0 ? cfg.scanMs * 1.5 : cfg.scanMs, easing: 'linear', fill: 'forwards' });
    }
    const first = rects.reduce((a, r) => (r.top < a.top ? r : a));
    const barTop = bar.getBoundingClientRect().top;
    // Above the choice if there's room, else below it; never under the bar.
    let y = first.top - 46;
    if (y < 4) y = first.top + first.height + 10;
    y = Math.min(y, barTop - 50);
    Object.assign(b.style, { left: Math.max(6, Math.min(first.left, innerWidth - 370)) + 'px', top: Math.max(4, y) + 'px' });
    layer.append(b);
  }

  function flash(node) {
    const leaves = node.children ? SP.leaves(node) : [node.item];
    for (const li of leaves) {
      const it = S.items[li];
      if (it && it.node) {
        it.node.classList.add('picked');
        setTimeout(() => it.node.classList.remove('picked'), 140);
      }
    }
    for (const ring of layer.querySelectorAll('.ring')) ring.classList.add('flash');
  }

  function speak(text) {
    if (!cfg.speak || !text || !('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.slice(0, 120));
    u.rate = 1.15;
    speechSynthesis.speak(u);
  }

  function renderDots() {
    const dots = $('.dots');
    dots.replaceChildren();
    if (S.mode !== 'page' || S.paused) return;
    for (let d = 0; d < Math.max(3, S.stack.length); d++) {
      const i = document.createElement('i');
      if (d < S.stack.length) i.className = 'on';
      dots.append(i);
    }
  }

  function setStatus(msg) {
    S.note = msg;
    clearTimeout(S.noteTimer);
    S.noteTimer = setTimeout(() => {
      S.note = '';
      renderStatus();
    }, 6000);
    renderStatus();
  }

  function renderStatus() {
    host.dataset.ai = S.aiState || ''; // for tests
    const hint = $('.hint');
    const chips = $('.chips');
    hint.className = 'hint' + (S.paused ? ' paused' : '');
    const hold = `${Math.round(cfg.holdMs / 1000)} s`;
    if (S.paused) hint.textContent = `Paused. Hold the switch for ${hold} to resume.`;
    else if (S.note) hint.textContent = S.note;
    else if (S.last && S.mode === 'page') hint.textContent = `Last pick: ${S.last.steps} steps. Row-column scanning would take ${S.last.rc}, one-by-one ${S.last.lin}.`;
    else hint.textContent = `Press ${keyName(cfg.switchKey)} to choose · hold ${hold} to pause`;
    chips.replaceChildren();
    if (S.goal) {
      const g = document.createElement('span');
      g.className = 'chip win';
      g.textContent = `Goal: ${S.goal}`;
      chips.append(g);
    }
    const ai = document.createElement('span');
    ai.className = 'chip';
    const dot = document.createElement('span');
    dot.className = 'd ' + S.aiState;
    ai.append(dot);
    const words = { ok: `AI: ${S.llmModel.replace(/^gemini-/, 'Gemini ')}`, waiting: 'AI thinking', error: 'AI unavailable, using your history', off: 'AI off', private: 'AI paused on this page' };
    ai.append(document.createTextNode(words[S.aiState] || 'AI off'));
    if (S.aiState === 'error' && S.aiError) ai.title = S.aiError;
    chips.append(ai);
  }

  const keyName = (code) => code.replace(/^Key/, '').replace(/^Digit/, '');

  // ---------- switch input ----------
  function onKeyDown(e) {
    if (e.code === cfg.switchKey && !e.repeat) S.downAt = performance.now();
    if (!S.on) return;
    if (e.code === cfg.switchKey || (cfg.nextKey && e.code === cfg.nextKey)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat && e.code === cfg.switchKey) pressTarget();
    }
  }

  function onKeyUp(e) {
    const held = performance.now() - S.downAt;
    if (!S.on) {
      // A long hold starts scanning, so the switch alone can bring it back.
      if (e.code === cfg.switchKey && S.downAt && held > cfg.holdMs) start();
      return;
    }
    if (cfg.nextKey && e.code === cfg.nextKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!S.paused) advance();
      return;
    }
    if (e.code !== cfg.switchKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (held > cfg.holdMs) return setPaused(!S.paused);
    if (S.paused) return;
    if (performance.now() - S.chosenAt < cfg.debounceMs) return; // a bounce or tremor, not a new choice
    choose();
  }

  // ---------- page changes ----------
  let changeTimer = null;
  function onChange() {
    if (!S.on || S.mode !== 'page' || S.paused) return;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      const top = S.stack[S.stack.length - 1];
      // Rebuild right away at the top level; inside a group wait for the user.
      if (S.stack.length === 1 && top.i <= 0) restart();
      else {
        S.rebuildPending = true;
        draw();
      }
    }, 500);
  }
  const observer = new MutationObserver(onChange);

  // ---------- on / off ----------
  async function loadSettings() {
    try {
      Object.assign(cfg, await chrome.storage.local.get(Object.keys(DEFAULTS)));
    } catch {}
    host.style.setProperty('--hl', COLORS[cfg.color] || COLORS.amber);
  }

  async function start() {
    if (S.on) return;
    await loadSettings();
    await loadHistory();
    try {
      const r = await chrome.runtime.sendMessage({ type: 'page', title: document.title });
      S.goal = (r && r.goal) || '';
    } catch {}
    document.documentElement.append(host);
    bar.hidden = false;
    S.on = true;
    S.paused = false;
    S.mode = 'page';
    S.aiState = 'off';
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'open'] });
    addEventListener('scroll', onChange, { passive: true, capture: true });
    addEventListener('resize', onChange);
    restart();
  }

  function stop() {
    S.on = false;
    clearTimeout(S.timer);
    observer.disconnect();
    removeEventListener('scroll', onChange, { capture: true });
    removeEventListener('resize', onChange);
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    host.remove();
  }

  addEventListener('keydown', onKeyDown, true);
  addEventListener('keyup', onKeyUp, true);
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'toggle') S.on ? stop() : start();
  });
  chrome.storage.onChanged.addListener((changes) => {
    for (const k in changes) if (k in DEFAULTS) cfg[k] = changes[k].newValue ?? DEFAULTS[k];
    host.style.setProperty('--hl', COLORS[cfg.color] || COLORS.amber);
  });
  loadSettings().then(() => cfg.autoStart && start());
})();
