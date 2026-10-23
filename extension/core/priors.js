// How likely is each on-screen choice to be the one the user wants?
//
// Three sources, mixed into one distribution that the scan tree is built from:
//   1. page heuristics: a log-linear score from what any page tells us
//      (element type, size, position, label, whether it sits in a nav bar)
//   2. personal history: what this user picked before on this site and page,
//      as counts with a 30-day half-life
//   3. a free-tier language model: reads the labels (and the user's goal, if
//      they gave one) and ranks the likely next clicks (see llm.js)
//
// Works in the browser (global `SwitchPath`) and in Node (module.exports).

(function (root) {
  // Feature weights for the heuristic score. bench/fit_heuristics.mjs fits
  // these on Mind2Web sites that are disjoint from the ones it tests on.
  const WEIGHTS = {
    bias: 0,
    logArea: 0.35,
    textInput: 1.6,
    search: 1.2,
    button: 0.5,
    select: 0.6,
    noLabel: -1.5,
    longLabel: -0.4,
    inNav: -0.2,
    inFooter: -1.0,
    belowFold: -0.6,
    top: 0.2,
  };

  // `d` is a plain descriptor so the same code scores live elements and
  // benchmark rows: {tag, role, type, text, box:[x,y,w,h], inNav, inFooter, viewport:[w,h]}.
  function features(d) {
    const tag = (d.tag || '').toLowerCase();
    const type = (d.type || '').toLowerCase();
    const role = (d.role || '').toLowerCase();
    const text = (d.text || '').trim();
    const [x, y, w, h] = d.box || [0, 0, 0, 0];
    const vh = (d.viewport && d.viewport[1]) || 800;
    const textInput = (tag === 'input' && !/^(submit|button|checkbox|radio|hidden|image|reset|file|range|color)$/.test(type)) || tag === 'textarea' || role === 'textbox' || role === 'searchbox' || role === 'combobox';
    return {
      bias: 1,
      logArea: Math.log1p(Math.max(0, w * h)) / 10,
      textInput: textInput ? 1 : 0,
      search: /search|query|\bq\b|find/i.test([type, role, text, d.name || '', d.placeholder || ''].join(' ')) ? 1 : 0,
      button: tag === 'button' || role === 'button' || /^(submit|button)$/.test(type) ? 1 : 0,
      select: tag === 'select' || role === 'listbox' || role === 'option' ? 1 : 0,
      noLabel: text ? 0 : 1,
      longLabel: text.length > 60 ? 1 : 0,
      inNav: d.inNav ? 1 : 0,
      inFooter: d.inFooter ? 1 : 0,
      belowFold: y > vh ? 1 : 0,
      top: y < vh * 0.25 ? 1 : 0,
    };
  }

  function heuristicProbs(descs, weights = WEIGHTS) {
    const s = descs.map((d) => {
      const f = features(d);
      let z = 0;
      for (const k in f) z += (weights[k] || 0) * f[k];
      return z;
    });
    return softmax(s);
  }

  function softmax(s) {
    if (!s.length) return [];
    const m = Math.max(...s);
    const e = s.map((v) => Math.exp(v - m));
    const t = e.reduce((a, b) => a + b, 0);
    return e.map((v) => v / t);
  }

  // A stable name for an element across visits: role, label and link path,
  // with digits folded so "Order #1234" matches "Order #5678".
  function signature(d) {
    const fold = (s) => (s || '').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 60);
    let path = '';
    if (d.href) {
      try {
        path = new URL(d.href, 'http://x/').pathname;
      } catch {
        path = d.href;
      }
    }
    return [(d.role || d.tag || '').toLowerCase(), fold(d.text), fold(path)].join('|');
  }

  const HALF_LIFE_DAYS = 30;

  // history: {sig: {n, t}} where n is a decayed count as of time t (ms).
  function recordPick(history, sig, now = Date.now()) {
    const h = history[sig] || { n: 0, t: now };
    h.n = decayed(h, now) + 1;
    h.t = now;
    history[sig] = h;
    return history;
  }

  function decayed(h, now) {
    return h.n * Math.pow(0.5, (now - h.t) / (HALF_LIFE_DAYS * 864e5));
  }

  // Mixes the sources. `pageHistory` (this URL path) counts double the
  // `siteHistory` (whole host). The heuristic acts as a Dirichlet prior worth
  // `strength` picks, so a single past click shifts things but doesn't
  // dominate; `llm` is {index: prob} for the ranked elements and gets weight
  // `llmWeight` (more when the user stated a goal).
  function mix(heur, sigs, { siteHistory = {}, pageHistory = {}, llm = null, llmWeight = 0.35, strength = 3, now = Date.now() } = {}) {
    const n = heur.length;
    const c = sigs.map((s) => 2 * (pageHistory[s] ? decayed(pageHistory[s], now) : 0) + (siteHistory[s] ? decayed(siteHistory[s], now) : 0));
    const C = c.reduce((a, b) => a + b, 0);
    let p = heur.map((h, i) => (c[i] + strength * h) / (C + strength));
    if (llm && Object.keys(llm).length) {
      const given = Object.entries(llm).filter(([i]) => +i < n);
      const mass = Math.min(1, given.reduce((a, [, v]) => a + Math.max(0, v), 0));
      const q = p.map((v) => v * (1 - mass));
      for (const [i, v] of given) q[+i] += Math.max(0, v);
      const tq = q.reduce((a, b) => a + b, 0) || 1;
      p = p.map((v, i) => (1 - llmWeight) * v + (llmWeight * q[i]) / tq);
    }
    return p;
  }

  const api = { WEIGHTS, features, heuristicProbs, softmax, signature, recordPick, decayed, mix };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SwitchPath = Object.assign(root.SwitchPath || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
