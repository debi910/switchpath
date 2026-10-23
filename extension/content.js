// SwitchPath content script: one-switch scanning over the live page.
//
// Every visible clickable element (plus scroll, back, goal and stop) gets a
// probability from page heuristics, this user's history on the site and a
// free-tier model's prediction. The choices are arranged into the scan tree
// that minimizes expected steps (core/tree.js), and the highlight walks that
// tree: press the switch on a group to enter it, on an element to use it.

(() => {
  if (window.__switchpath) return;
  window.__switchpath = true;
  const SP = globalThis.SwitchPath;

  const DEFAULTS = {
    switchKey: 'Space',
    nextKey: '', // set for two-switch step scanning (no timer)
    scanMs: 1100,
    graceMs: 150, // presses this soon after the highlight moves count for the previous choice
    order: 'coherent',
    laps: 2,
    autoStart: false,
    useModel: true,
  };
  const ACTIONS = [
    { id: 'down', label: 'Scroll down', prior: 0.08 },
    { id: 'up', label: 'Scroll up', prior: 0.02 },
    { id: 'back', label: 'Back', prior: 0.03 },
    { id: 'goal', label: 'Tell AI my goal', prior: 0.01 },
    { id: 'stop', label: 'Stop scanning', prior: 0.005 },
  ];
  const SELECTOR = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary',
    '[role=button]', '[role=link]', '[role=tab]', '[role=menuitem]', '[role=checkbox]', '[role=radio]',
    '[role=option]', '[role=switch]', '[role=combobox]', '[role=searchbox]', '[role=textbox]',
    '[contenteditable=""]', '[contenteditable=true]', '[onclick]', '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  // Clickables whose insides are one choice, not many.
  const ATOMIC = 'a[href],button,summary,[role=button],[role=link],[role=option],[role=menuitem],[role=tab]';

  let cfg = { ...DEFAULTS };
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
    rebuildPending: false,
    downAt: 0,
    kb: null, // {target, text, kind: 'field'|'goal', suggestions: []}
    last: '',
  };

  // ---------- overlay (shadow DOM so page styles can't touch it) ----------
  const host = document.createElement('switchpath-overlay');
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>
    :host { all: initial; }
    .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; }
    .box { position: fixed; box-sizing: border-box; border-radius: 6px; transition: all 80ms; }
    .box.cur { border: 4px solid #ffb000; background: rgba(255, 176, 0, 0.22); box-shadow: 0 0 0 3px #000c; }
    .box.sib { border: 2px dashed rgba(30, 90, 255, 0.55); }
    .badge { position: fixed; font: 700 14px/1.2 system-ui, sans-serif; background: #000; color: #ffb000; padding: 2px 7px; border-radius: 4px; }
    .bar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483647; background: #111e; color: #fff;
      font: 15px/1.3 system-ui, sans-serif; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; pointer-events: auto; }
    .row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .btn { border: 2px solid #555; border-radius: 6px; padding: 6px 10px; background: #222; color: #fff; font: inherit; min-width: 28px; text-align: center; }
    .status { opacity: 0.85; font-size: 13px; flex: 1; min-width: 200px; }
    .text { background: #fff; color: #000; padding: 6px 8px; border-radius: 4px; min-height: 22px; font-size: 17px; flex: 1; }
    .sugg { border-color: #3a7; }
    .ai { border-color: #a5f; }
    [hidden] { display: none !important; }
  </style>
  <div class="layer"></div>
  <div class="bar" hidden>
    <div class="row kbtext" hidden><span class="label"></span><div class="text"></div></div>
    <div class="row kbsugg" hidden></div>
    <div class="row kbkeys" hidden></div>
    <div class="row selopts" hidden></div>
    <div class="row actions"></div>
    <div class="row"><span class="status"></span></div>
  </div>`;
  const $ = (s) => shadow.querySelector(s);
  const layer = $('.layer');
  const bar = $('.bar');
  const statusEl = $('.status');
  for (const a of ACTIONS) {
    const b = document.createElement('div');
    b.className = 'btn';
    b.dataset.action = a.id;
    b.textContent = a.label;
    $('.actions').append(b);
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
    // Duplicate labels pointing at the same place (image + title links) stay
    // separate choices; the tree puts them where they cost least.
    return els;
  }

  function actionItems() {
    const out = [];
    const se = document.scrollingElement || document.documentElement;
    for (const a of ACTIONS) {
      const off = (a.id === 'down' && se.scrollTop + innerHeight >= se.scrollHeight - 4) || (a.id === 'up' && se.scrollTop <= 0) || (a.id === 'back' && history.length <= 1);
      shadow.querySelector(`[data-action=${a.id}]`).hidden = off;
      if (off) continue;
      out.push({ kind: 'action', id: a.id, text: a.label, prior: a.prior, node: shadow.querySelector(`[data-action=${a.id}]`) });
    }
    return out;
  }

  // ---------- history ----------
  const histKey = 'hist:' + location.host;
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
    if (it.kind === 'action' || it.kind === 'key') {
      const r = it.node.getBoundingClientRect();
      return [r.left, r.top + 10000, r.width, r.height]; // after page content
    }
    return it.box;
  }

  // ---------- the model ----------
  let askTimer = null;
  function askModel(items) {
    if (!cfg.useModel) return;
    const labels = items.map((it) => it.text).join('\u0001');
    if (labels === S.askedFor) return;
    clearTimeout(askTimer);
    // Wait for the page to settle; at most one call every few seconds.
    const wait = Math.max(300, 3000 - (Date.now() - S.llmAt));
    askTimer = setTimeout(async () => {
      S.askedFor = labels;
      S.llmAt = Date.now();
      const elements = items.map((it, i) => ({ id: i, kind: it.kind, label: (it.text || '(no label)').slice(0, 80), region: it.region }));
      let r;
      try {
        r = await chrome.runtime.sendMessage({ type: 'rank', url: location.href, title: document.title, elements });
      } catch {
        return;
      }
      if (!r || r.error || !S.on) {
        if (r && r.error && r.error !== 'off') setStatus(`Model unavailable (${r.error.slice(0, 60)}); using history and page cues.`);
        return;
      }
      S.llm = {};
      for (const [i, p] of Object.entries(r.probs)) if (items[+i]) S.llm[items[+i].text] = p;
      S.llmModel = r.model;
      // Don't move things under the user mid-choice: apply at the next top.
      if (S.mode === 'page') {
        if (S.stack.length === 1 && S.stack[0].i <= 0) restart();
        else S.rebuildPending = true;
      }
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
    top.i++;
    if (top.i >= top.list.length) {
      top.i = 0;
      top.laps++;
      if (S.stack.length > 1 && top.laps >= cfg.laps) {
        // Nothing chosen in this group: go back up.
        S.stack.pop();
        S.stack[S.stack.length - 1].i = 0;
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
    S.pressI = p && p.top === top && p.i >= 0 && performance.now() - p.at < cfg.graceMs ? p.i : top.i;
  }

  function choose() {
    const top = S.stack[S.stack.length - 1];
    if (S.pressI != null && top) top.i = S.pressI;
    S.pressI = null;
    S.prev = null;
    const node = current();
    if (!node) return;
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
      S.last = `Last pick: ${steps} steps (row-column scanning: ${rc}, one-by-one: ${lin}).`;
      logStats(steps, rc, lin);
      rememberPick(it.sig);
    }
    activate(it);
  }

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
    const se = document.scrollingElement || document.documentElement;
    if (id === 'down') se.scrollBy({ top: innerHeight * 0.8, behavior: 'instant' });
    if (id === 'up') se.scrollBy({ top: -innerHeight * 0.8, behavior: 'instant' });
    if (id === 'back') history.back();
    if (id === 'stop') return stop();
    if (id === 'goal') return openKeyboard({ kind: 'goal', field: 'Your goal', text: S.goal });
    settleThenRestart(id === 'back' ? 900 : 250);
  }

  // ---------- dropdowns ----------
  function openSelect(sel) {
    S.mode = 'select';
    const row = $('.selopts');
    row.replaceChildren();
    row.hidden = false;
    const opts = [...sel.options].filter((o) => !o.disabled);
    const items = opts.map((o) => {
      const b = document.createElement('div');
      b.className = 'btn';
      b.textContent = o.text;
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
  const EXTRA = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '@', '-', ','];
  const wordIndex = SP.WORDS.map((w, i) => [w, Math.exp(SP.WORD_LOGP[i])]);

  function openKeyboard(kb) {
    S.mode = 'keyboard';
    S.kb = { text: kb.kind === 'field' ? currentText(kb.target) : kb.text || '', aiSugg: [], ...kb };
    if (kb.kind === 'goal') S.kb.text = S.goal;
    $('.kbtext').hidden = $('.kbsugg').hidden = $('.kbkeys').hidden = false;
    $('.kbtext .label').textContent = kb.kind === 'goal' ? 'What do you want to do here?' : `Typing into: ${kb.field}`;
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
    const add = (label, kind, value, weight) => keys.push({ kind: 'key', text: label, key: kind, value, w: weight });
    const tot = Object.values(m.next).reduce((a, b) => a + b, 0) + m.wordEnd || 1;
    for (const s of kb.aiSugg) add(s, 'ai', s, 0.12);
    for (const [w, p] of m.completions) add(w, 'word', w, (0.5 * p) / tot);
    add('space', 'char', ' ', m.prefix ? 0.08 + (0.5 * m.wordEnd) / tot : 0.01);
    for (const c of LETTERS) add(c, 'char', c, 0.004 + (0.6 * (m.next[c] || 0)) / tot);
    for (const c of EXTRA) add(c, 'char', c, 0.002);
    add('⌫ delete', 'del', '', 0.03);
    add(kb.kind === 'goal' ? '✓ save goal' : '⏎ enter / go', 'enter', '', kb.text.length > 2 ? 0.06 : 0.005);
    add('✕ close keyboard', 'close', '', 0.01);
    // Lay keys out: suggestions on top, keys below, in a fixed order so the
    // user's eyes learn where things are; the tree decides the grouping.
    const sugRow = $('.kbsugg');
    const keyRow = $('.kbkeys');
    sugRow.replaceChildren();
    keyRow.replaceChildren();
    for (const k of keys) {
      const b = document.createElement('div');
      b.className = 'btn' + (k.key === 'ai' ? ' ai' : k.key === 'word' ? ' sugg' : '');
      b.textContent = k.key === 'ai' ? `✨ ${k.text}` : k.text;
      (k.key === 'ai' || k.key === 'word' ? sugRow : keyRow).append(b);
      k.node = b;
    }
    $('.kbtext .text').textContent = kb.text + '▏';
    S.items = keys;
    S.tree = SP.buildTree(keys.map((k) => k.w), { order: 'fast' });
    S.stack = [{ list: S.tree.children, i: -1, laps: 0 }];
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
    if (!cfg.useModel) return;
    clearTimeout(suggTimer);
    suggTimer = setTimeout(async () => {
      const kb = S.kb;
      if (!kb) return;
      const typed = kb.text;
      let r;
      try {
        r = await chrome.runtime.sendMessage({ type: 'suggest', url: location.href, title: document.title, field: kb.kind === 'goal' ? 'a short description of what the user wants to do on this page' : kb.field, typed });
      } catch {
        return;
      }
      if (!r || r.error || S.kb !== kb || kb.text !== typed) return;
      kb.aiSugg = r.suggestions.slice(0, 3);
      // Only rebuild if the user hasn't started moving through the keys.
      if (S.stack.length === 1 && S.stack[0].i <= 0) restart();
    }, 150);
  }

  // ---------- drawing ----------
  function rectOf(it) {
    if (it.node) return it.node.getBoundingClientRect();
    if (it.el && it.el.isConnected) return it.el.getBoundingClientRect();
    const [x, y, w, h] = it.box;
    return { left: x, top: y, width: w, height: h };
  }

  function draw() {
    layer.replaceChildren();
    const top = S.stack[S.stack.length - 1];
    if (!S.on || !top) return;
    const cur = current();
    top.list.forEach((node, t) => {
      const leaves = node.children ? SP.leaves(node) : [node.item];
      const cls = node === cur ? 'cur' : 'sib';
      let first = null;
      for (const li of leaves) {
        const it = S.items[li];
        if (!it) continue;
        const r = rectOf(it);
        const b = document.createElement('div');
        b.className = 'box ' + cls;
        Object.assign(b.style, { left: r.left - 3 + 'px', top: r.top - 3 + 'px', width: r.width + 6 + 'px', height: r.height + 6 + 'px' });
        layer.append(b);
        if (!first || r.top < first.top) first = r;
      }
      if (node === cur && first) {
        const badge = document.createElement('div');
        badge.className = 'badge';
        badge.textContent = node.children ? `${leaves.length} choices` : S.items[node.item].text.slice(0, 40) || '(no label)';
        Object.assign(badge.style, { left: Math.max(0, first.left) + 'px', top: Math.max(0, first.top - 24) + 'px' });
        layer.append(badge);
        // For automated tests and screen readers outside the closed shadow.
        host.dataset.current = node.children ? `group:${leaves.length}` : S.items[node.item].text;
        host.dataset.leaves = JSON.stringify(leaves.map((li) => S.items[li] && S.items[li].text));
      }
    });
    host.dataset.depth = S.stack.length;
    host.dataset.mode = S.mode;
    renderStatus();
  }

  function setStatus(msg) {
    S.note = msg;
    renderStatus();
  }

  function renderStatus() {
    const parts = [];
    if (S.paused) parts.push('Paused. Hold the switch for 2 seconds to resume.');
    else if (S.mode === 'page') parts.push(`Depth ${S.stack.length} · press ${keyName(cfg.switchKey)} to choose · hold 2 s to pause`);
    if (S.goal) parts.push(`Goal: ${S.goal}`);
    if (S.llmModel && S.mode === 'page') parts.push(`AI: ${S.llmModel}`);
    if (S.last) parts.push(S.last);
    if (S.note) parts.push(S.note);
    statusEl.textContent = parts.join('  ·  ');
  }

  const keyName = (code) => code.replace(/^Key/, '');

  // ---------- switch input ----------
  function onKeyDown(e) {
    if (!S.on) return;
    if (e.code === cfg.switchKey || (cfg.nextKey && e.code === cfg.nextKey)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat && e.code === cfg.switchKey) {
        S.downAt = performance.now();
        pressTarget();
      }
    }
  }

  function onKeyUp(e) {
    if (!S.on) return;
    if (cfg.nextKey && e.code === cfg.nextKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!S.paused) advance();
      return;
    }
    if (e.code !== cfg.switchKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const held = performance.now() - S.downAt;
    if (held > 2000) {
      S.paused = !S.paused;
      if (!S.paused) restart();
      else clearTimeout(S.timer);
      renderStatus();
      return;
    }
    if (S.paused) return;
    choose();
  }

  // ---------- page changes ----------
  let changeTimer = null;
  function onChange() {
    if (!S.on || S.mode !== 'page') return;
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
  async function start() {
    if (S.on) return;
    try {
      Object.assign(cfg, await chrome.storage.local.get(Object.keys(DEFAULTS)));
    } catch {}
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
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'open'] });
    addEventListener('scroll', onChange, { passive: true });
    addEventListener('resize', onChange);
    restart();
  }

  function stop() {
    S.on = false;
    clearTimeout(S.timer);
    observer.disconnect();
    removeEventListener('scroll', onChange);
    removeEventListener('resize', onChange);
    host.remove();
  }

  addEventListener('keydown', onKeyDown, true);
  addEventListener('keyup', onKeyUp, true);
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'toggle') S.on ? stop() : start();
  });
  chrome.storage.local.get(['autoStart']).then((s) => s.autoStart && start(), () => {});
})();
