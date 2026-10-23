// Benchmark: how many scan steps does a single-switch user need for each
// real click in Mind2Web (1,009 tasks on 73 live websites, train split)?
//
//   node bench/run.mjs --data mind2web_train_steps.jsonl.gz [--llm 300] [--json out.json]
//
// Each step of a task is one choice: the element the human annotator used.
// The user sees one 1280x720 screen at a time. If the target is further down
// they first choose "Scroll down" on each screen in between (80% of a screen
// per scroll), exactly as with the extension. Every method sees the same
// screens and the same actions; only the scanning order differs.
//
// Methods:
//   linear        one element at a time in reading order (iOS/macOS item mode)
//   row-column    rows of the screen, then items in the row (most AAC devices)
//   tree/*        SwitchPath's optimal scan tree with different priors
//
// --llm N adds free-tier model priors on N randomly chosen steps, both
// without the goal (page only) and with the task text as the user's goal.
// Answers are cached in bench/llm-cache.json, so re-runs cost nothing.

import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const T = require('../extension/core/tree.js');
const P = require('../extension/core/priors.js');
const here = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i < 0 ? dflt : args[i + 1];
};
const DATA = opt('data', path.join(here, '..', '..', 'm2w', 'mind2web_train_steps.jsonl.gz'));
const LLM_N = +opt('llm', 0);
const [PAGE_W, GOAL_W] = opt('llm-weights', '0.35,0.6').split(',').map(Number);
const CACHED_ONLY = args.includes('--cached-only'); // score with the answers already cached
const LIMIT = +opt('limit', 0);
const JSON_OUT = opt('json', null);
const W = 1280;
const H = 720;
const SCROLL = 0.8 * H;

const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'option']);
const INTERACTIVE_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'option', 'switch', 'combobox', 'searchbox', 'textbox', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'gridcell']);
const ACTIONS = [
  { id: 'down', label: 'Scroll down', prior: 0.08 },
  { id: 'up', label: 'Scroll up', prior: 0.02 },
  { id: 'back', label: 'Back', prior: 0.03 },
  { id: 'goal', label: 'Tell AI my goal', prior: 0.01 },
  { id: 'stop', label: 'Stop scanning', prior: 0.005 },
];

// ---------- turning a Mind2Web step into screens ----------
function descriptor(e) {
  const a = e.attrs || {};
  const hint = `${a.class || ''} ${a.id || ''}`;
  return {
    id: e.id,
    kind: 'element',
    tag: e.tag,
    role: a.role || '',
    type: a.type || '',
    text: (e.text || a.aria_label || a.placeholder || a.name || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    name: a.name || '',
    placeholder: a.placeholder || '',
    pageBox: e.bbox,
    inNav: /nav|menu|header|topbar|breadcrumb/i.test(hint),
    inFooter: /footer/i.test(hint),
  };
}

function interactive(e) {
  return INTERACTIVE_TAGS.has(e.tag) || INTERACTIVE_ROLES.has((e.attrs || {}).role);
}

// Screens from the top of the page down to the one showing the target.
function screensFor(step) {
  const targets = new Set(step.targets);
  const els = step.elements.filter((e) => {
    const [x, , w, h] = e.bbox;
    if (w < 4 || h < 4 || x >= W || x + w <= 0) return false;
    if (w * h > W * H * 0.9) return false; // page containers
    return targets.has(e.id) || interactive(e);
  });
  const target = els.find((e) => targets.has(e.id));
  if (!target) return null;
  const cy = (b) => b[1] + b[3] / 2;
  let k = 0;
  while (!(k * SCROLL <= cy(target.bbox) && cy(target.bbox) < k * SCROLL + H)) k++;
  const pageBottom = Math.max(...step.elements.map((e) => e.bbox[1] + e.bbox[3]));
  const screens = [];
  for (let j = 0; j <= k; j++) {
    const top = j * SCROLL;
    const items = els
      .filter((e) => cy(e.bbox) >= top && cy(e.bbox) < top + H)
      .map((e) => {
        const d = descriptor(e);
        d.box = [e.bbox[0], e.bbox[1] - top, e.bbox[2], e.bbox[3]];
        d.viewport = [W, H];
        return d;
      });
    let bx = 10;
    for (const a of ACTIONS) {
      if (a.id === 'down' && top + H >= pageBottom) continue;
      if (a.id === 'up' && j === 0) continue;
      if (a.id === 'back' && step.step === 0) continue;
      items.push({ kind: 'action', id: a.id, text: a.label, prior: a.prior, box: [bx, H + 10, 120, 40] });
      bx += 130;
    }
    const want = j < k ? items.findIndex((it) => it.id === 'down') : items.findIndex((it) => it.kind === 'element' && targets.has(it.id));
    if (want < 0) return null;
    for (const it of items) it.sig = it.kind === 'action' ? 'action|' + it.id : P.signature(it);
    screens.push({ items, want });
  }
  return screens;
}

// ---------- priors ----------
function basePrior(items, weights) {
  const els = items.filter((it) => it.kind === 'element');
  const heur = weights ? P.heuristicProbs(els, weights) : els.map(() => 1 / els.length);
  const acts = items.filter((it) => it.kind === 'action');
  const actMass = acts.reduce((a, x) => a + x.prior, 0);
  let e = 0;
  return items.map((it) => (it.kind === 'action' ? it.prior : heur[e++] * (1 - actMass)));
}

// Conditional logit: softmax over the screen's elements, fitted by gradient
// ascent with a little L2. Only screens whose target is an element.
function fitWeights(examples, iters = 150, lr = 0.5, l2 = 1e-3) {
  const keys = Object.keys(P.WEIGHTS);
  const w = Object.fromEntries(keys.map((k) => [k, 0]));
  const feats = examples.map(({ els, want }) => ({ F: els.map((d) => P.features(d)), want }));
  for (let it = 0; it < iters; it++) {
    const g = Object.fromEntries(keys.map((k) => [k, -l2 * w[k]]));
    for (const { F, want } of feats) {
      const z = F.map((f) => keys.reduce((s, k) => s + w[k] * f[k], 0));
      const p = P.softmax(z);
      for (const k of keys) {
        let e = 0;
        for (let i = 0; i < F.length; i++) e += p[i] * F[i][k];
        g[k] += (F[want][k] - e) / feats.length;
      }
    }
    for (const k of keys) w[k] += lr * g[k];
  }
  return w;
}

// ---------- costs ----------
function costs(screen, probs, order = 'coherent') {
  const { items, want } = screen;
  const boxes = items.map((it) => it.box);
  const reading = T.readingOrderOf(boxes);
  const tree = T.buildTree(probs, { order, readingOrder: reading, maxItems: 2000 });
  return T.stepsTo(tree, want);
}

function baselineCosts(screen) {
  const boxes = screen.items.map((it) => it.box);
  const reading = T.readingOrderOf(boxes);
  return { linear: T.linearSteps(reading, screen.want), rowcol: T.rowColumnSteps(T.rowsOf(boxes, reading), screen.want) };
}

// ---------- main ----------
async function* readSteps() {
  const rl = readline.createInterface({ input: fs.createReadStream(DATA).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) yield JSON.parse(line);
}

const siteFold = (site) => [...site].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 2;

console.error('Pass 1: screens and training data');
const steps = [];
let skipped = 0;
for await (const step of readSteps()) {
  const screens = screensFor(step);
  if (!screens) {
    skipped++;
    continue;
  }
  steps.push({ task_id: step.task_id, website: step.website, domain: step.domain, task: step.task, step: step.step, screens });
  if (LIMIT && steps.length >= LIMIT) break;
}
console.error(`${steps.length} steps usable, ${skipped} skipped (target not a visible element)`);

// Two-fold by website: weights are always fitted on the other half of sites.
const foldWeights = [0, 1].map((f) =>
  fitWeights(
    steps
      .filter((s) => siteFold(s.website) !== f)
      .map((s) => s.screens.at(-1))
      .map((sc) => {
        const els = sc.items.filter((it) => it.kind === 'element');
        return { els, want: els.indexOf(sc.items[sc.want]) };
      })
  )
);
console.error('Fitted weights (fold 0):', JSON.stringify(foldWeights[0], (k, v) => (typeof v === 'number' ? +v.toFixed(2) : v)));

// LLM subset: a fixed random sample of steps.
let rng = 12345;
const rand = () => ((rng = (rng * 1103515245 + 12345) >>> 0) / 4294967296);
const llmIdx = new Set();
if (LLM_N) {
  const order = steps.map((_, i) => i).sort(() => rand() - 0.5);
  for (const i of order.slice(0, LLM_N)) llmIdx.add(i);
}
const cachePath = path.join(here, 'llm-cache.json');
const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : {};

if (LLM_N && !CACHED_ONLY) {
  const { rankElements } = await import('../extension/core/llm.js');
  const apiKey = process.env.GEMINI_API_KEY;
  const jobs = [];
  for (const i of llmIdx) {
    const s = steps[i];
    s.screens.forEach((sc, j) => {
      for (const mode of ['page', 'goal']) {
        const key = `${mode}|${s.task_id}|${s.step}|${j}`;
        if (!(key in cache)) jobs.push({ key, s, sc, mode });
      }
    });
  }
  console.error(`Model calls needed: ${jobs.length} (cached: ${Object.keys(cache).length})`);
  let done = 0;
  let failed = 0;
  const worker = async () => {
    while (jobs.length) {
      const { key, s, sc, mode } = jobs.shift();
      const elements = sc.items.map((it, id) => ({ id, kind: it.kind === 'action' ? 'action' : it.role || it.tag, label: it.text || '(no label)' }));
      try {
        const r = await rankElements({ apiKey, url: `https://www.${s.website}.com/`, title: `${s.website} (${s.domain})`, trail: [], goal: mode === 'goal' ? s.task : '', elements });
        cache[key] = r;
      } catch (e) {
        if (++failed > 400) jobs.length = 0;
        if (failed <= 5) console.error('model call failed:', e.message);
        jobs.push({ key, s, sc, mode }); // retry later
        await new Promise((r) => setTimeout(r, Math.max(5000, (e.retryAt || 0) - Date.now())));
      }
      if (++done % 25 === 0) {
        fs.writeFileSync(cachePath, JSON.stringify(cache));
        console.error(`model: ${done} done, ${failed} failed, ${jobs.length} left`);
      }
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
  fs.writeFileSync(cachePath, JSON.stringify(cache));
}

// Score the model only on steps where every screen got an answer, so a quota
// hiccup never silently falls back to the no-model prior.
for (const i of [...llmIdx]) {
  const s = steps[i];
  if (!s.screens.every((_, j) => ['page', 'goal'].every((m) => cache[`${m}|${s.task_id}|${s.step}|${j}`]))) llmIdx.delete(i);
}
console.error(`Model subset: ${llmIdx.size} steps fully answered`);
console.error('Pass 2: scoring');
const METHODS = ['linear', 'rowcol', 'tree/uniform', 'tree/heuristic', 'tree/fitted', 'tree/fitted+history', 'tree/fitted+history (fast)'];
const LLM_METHODS = ['tree/fitted+history', 'tree/+model (page only)', 'tree/+model+goal', 'rowcol', 'linear'];
const tot = Object.fromEntries(METHODS.map((m) => [m, []]));
const llmTot = Object.fromEntries(LLM_METHODS.map((m) => [m, []]));
const byDomain = {};
const history = {}; // website -> site history (earlier tasks only)
const tasksSeen = {}; // website -> set of task ids already counted
let pendingHistory = []; // picks of the current task, added when the task ends
let curTask = null;

steps.forEach((s, idx) => {
  if (s.task_id !== curTask) {
    for (const [site, sig] of pendingHistory) P.recordPick((history[site] ||= {}), sig, 0);
    pendingHistory = [];
    curTask = s.task_id;
  }
  const w = foldWeights[siteFold(s.website)];
  const hist = history[s.website] || {};
  const c = Object.fromEntries(METHODS.map((m) => [m, 0]));
  const cl = Object.fromEntries(LLM_METHODS.map((m) => [m, 0]));
  s.screens.forEach((sc, j) => {
    const b = baselineCosts(sc);
    c.linear += b.linear;
    c.rowcol += b.rowcol;
    const uni = basePrior(sc.items, null);
    const heur = basePrior(sc.items, P.WEIGHTS);
    const fit = basePrior(sc.items, w);
    const sigs = sc.items.map((it) => it.sig);
    const withHist = P.mix(fit, sigs, { siteHistory: hist, now: 0 });
    c['tree/uniform'] += costs(sc, uni);
    c['tree/heuristic'] += costs(sc, heur);
    c['tree/fitted'] += costs(sc, fit);
    c['tree/fitted+history'] += costs(sc, withHist);
    c['tree/fitted+history (fast)'] += costs(sc, withHist, 'fast');
    if (llmIdx.has(idx)) {
      cl.linear += b.linear;
      cl.rowcol += b.rowcol;
      cl['tree/fitted+history'] += costs(sc, withHist);
      for (const [mode, name] of [['page', 'tree/+model (page only)'], ['goal', 'tree/+model+goal']]) {
        const r = cache[`${mode}|${s.task_id}|${s.step}|${j}`];
        const probs = r ? P.mix(fit, sigs, { siteHistory: hist, llm: r.probs, llmWeight: mode === 'goal' ? GOAL_W : PAGE_W, now: 0 }) : withHist;
        cl[name] += costs(sc, probs);
      }
    }
  });
  for (const m of METHODS) tot[m].push(c[m]);
  if (llmIdx.has(idx)) for (const m of LLM_METHODS) llmTot[m].push(cl[m]);
  const dom = (byDomain[s.domain] ||= Object.fromEntries(METHODS.map((m) => [m, []])));
  for (const m of METHODS) dom[m].push(c[m]);
  pendingHistory.push([s.website, s.screens.at(-1).items[s.screens.at(-1).want].sig]);
  for (const sc of s.screens.slice(0, -1)) pendingHistory.push([s.website, 'action|down']);
});

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const median = (a) => {
  const b = [...a].sort((x, y) => x - y);
  return b[Math.floor(b.length / 2)];
};
const signed = (x) => `${x > 0 ? '+' : ''}${x.toFixed(0)}%`;
const summarize = (t, base) =>
  Object.entries(t).map(([m, a]) => ({
    method: m,
    steps: +mean(a).toFixed(2),
    median: median(a),
    secondsAt1sPerStep: +mean(a).toFixed(1),
    vsRowColumn: base ? signed(100 * (mean(a) / mean(t[base]) - 1)) : '',
    within5: `${((100 * a.filter((x) => x <= 5).length) / a.length).toFixed(0)}%`,
  }));

const main = summarize(tot, 'rowcol');
console.log(`\nAll ${steps.length} steps (each step's cost includes any scrolling to reach the target):`);
console.table(main);
const domains = Object.entries(byDomain).map(([d, t]) => ({
  domain: d,
  steps: t.linear.length,
  linear: +mean(t.linear).toFixed(1),
  rowcol: +mean(t.rowcol).toFixed(1),
  switchpath: +mean(t['tree/fitted+history']).toFixed(1),
}));
console.table(domains);
let llmRows = null;
if (LLM_N) {
  llmRows = summarize(llmTot, 'rowcol');
  console.log(`\nSubset with model predictions (${llmTot.linear.length} steps):`);
  console.table(llmRows);
}
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ steps: steps.length, skipped, main, domains, llm: llmRows, weights: foldWeights }, null, 2));
