import { DEFAULT_MODELS, listModels } from './core/llm.js';

const DEFAULTS = {
  switchKey: 'Space', nextKey: '', scanMs: 1100, holdMs: 2000, debounceMs: 300, adaptive: true, speak: false, color: 'amber',
  order: 'coherent', laps: 2, autoStart: true, useModel: true, apiKey: '', models: DEFAULT_MODELS, noAiSites: '',
};
const COLORS = { amber: '#ffb000', cyan: '#00d5ff', magenta: '#ff4fd8', lime: '#9dff3a' };
const $ = (id) => document.getElementById(id);
const save = (patch) => chrome.storage.local.set(patch);
const keyName = (code) => (code ? code.replace(/^Key/, '').replace(/^Digit/, '') : 'none');
let s;

async function load() {
  s = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  $('switchKeyShow').textContent = keyName(s.switchKey);
  $('nextKeyShow').textContent = keyName(s.nextKey);
  for (const id of ['scanMs', 'holdMs', 'debounceMs', 'laps', 'order', 'apiKey', 'noAiSites']) $(id).value = s[id];
  for (const id of ['adaptive', 'speak', 'autoStart', 'useModel']) $(id).checked = s[id];
  $('models').value = s.models.join('\n');
  for (const [name, hex] of Object.entries(COLORS)) {
    const l = document.createElement('label');
    l.style.background = hex;
    l.title = name;
    const r = Object.assign(document.createElement('input'), { type: 'radio', name: 'color', value: name, checked: s.color === name });
    r.setAttribute('aria-label', name);
    r.addEventListener('change', () => {
      save({ color: name });
      document.documentElement.style.setProperty('--hl', hex);
    });
    l.append(r);
    $('swatches').append(l);
  }
  document.documentElement.style.setProperty('--hl', COLORS[s.color] || COLORS.amber);
  const { usage, stats } = await chrome.storage.local.get(['usage', 'stats']);
  if (usage && usage.day === new Date().toISOString().slice(0, 10)) $('usage').textContent = Object.entries(usage.calls).map(([m, n]) => `${m}: ${n}`).join(', ');
  if (stats && stats.picks) showStats(stats);
}

function showStats(st) {
  const f = (x) => x / st.picks;
  $('stat').textContent = `${f(st.steps).toFixed(1)} steps per pick`;
  $('statHint').textContent = `Over your last ${st.picks.toLocaleString()} picks. Your history stays in this browser.`;
  const rows = [['SwitchPath', f(st.steps), true], ['Row-column scanning', f(st.rc)], ['One-by-one scanning', f(st.lin)]];
  const max = Math.max(...rows.map((r) => r[1]));
  const box = $('compare');
  box.hidden = false;
  box.replaceChildren(
    ...rows.map(([name, v, me]) => {
      const r = document.createElement('div');
      r.className = 'r' + (me ? ' me' : '');
      const b = document.createElement('div');
      b.className = 'b';
      const i = document.createElement('i');
      i.style.width = `${(100 * v) / max}%`;
      b.append(i);
      r.append(Object.assign(document.createElement('span'), { textContent: name }), b, Object.assign(document.createElement('span'), { className: 'v', textContent: v.toFixed(1) }));
      return r;
    })
  );
}

for (const id of ['scanMs', 'holdMs', 'debounceMs', 'laps']) $(id).addEventListener('change', (e) => save({ [id]: +e.target.value }));
$('order').addEventListener('change', (e) => save({ order: e.target.value }));
for (const id of ['adaptive', 'speak', 'autoStart', 'useModel']) $(id).addEventListener('change', (e) => save({ [id]: e.target.checked }));
$('apiKey').addEventListener('change', (e) => save({ apiKey: e.target.value.trim() }));
$('noAiSites').addEventListener('change', (e) => save({ noAiSites: e.target.value }));
$('models').addEventListener('change', (e) => save({ models: e.target.value.split(/\s+/).filter(Boolean) }));

// Switch tester: lights up while the switch is held, and says which key it sent.
let capturing = null;
addEventListener('keydown', (e) => {
  if (capturing) {
    e.preventDefault();
    save({ [capturing.field]: e.code });
    capturing.show.textContent = keyName(e.code);
    capturing.btn.textContent = 'Change';
    if (capturing.field === 'switchKey') s.switchKey = e.code;
    capturing = null;
    return;
  }
  if (e.code === s.switchKey && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
    e.preventDefault();
    $('tester').classList.add('on');
    $('testerText').textContent = `Got it: your switch sends ${keyName(e.code)}.`;
  } else if (!/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
    $('testerText').textContent = `That was ${keyName(e.code)}. Your switch key is set to ${keyName(s.switchKey)}; press Change below to use ${keyName(e.code)} instead.`;
  }
});
addEventListener('keyup', () => $('tester').classList.remove('on'));

function capture(btn, field, show) {
  btn.addEventListener('click', () => {
    capturing = { btn, field, show };
    btn.textContent = 'Press your switch now…';
  });
}
capture($('captureSwitch'), 'switchKey', $('switchKeyShow'));
capture($('captureNext'), 'nextKey', $('nextKeyShow'));
$('clearNext').addEventListener('click', () => {
  save({ nextKey: '' });
  $('nextKeyShow').textContent = 'none';
});

$('test').addEventListener('click', async () => {
  const out = $('testOut');
  out.className = 'hint';
  out.textContent = 'Checking…';
  try {
    const models = await listModels($('apiKey').value.trim());
    const wanted = $('models').value.split(/\s+/).filter(Boolean);
    const have = wanted.filter((m) => models.includes(m));
    out.className = 'hint ok';
    out.textContent = `Key works. ${have.length} of your ${wanted.length} models are available.`;
  } catch (e) {
    out.className = 'hint err';
    out.textContent = 'Key failed: ' + e.message;
  }
});

$('clearHistory').addEventListener('click', async () => {
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith('hist:')));
  $('clearOut').textContent = 'Done.';
});

load();
