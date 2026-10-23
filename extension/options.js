import { DEFAULT_MODELS, listModels } from './core/llm.js';

const DEFAULTS = { switchKey: 'Space', nextKey: '', scanMs: 1100, order: 'coherent', laps: 2, autoStart: false, useModel: true, apiKey: '', models: DEFAULT_MODELS };
const $ = (id) => document.getElementById(id);

async function load() {
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  $('switchKeyShow').textContent = s.switchKey;
  $('nextKeyShow').textContent = s.nextKey || '(none)';
  $('scanMs').value = s.scanMs;
  $('laps').value = s.laps;
  $('order').value = s.order;
  $('autoStart').checked = s.autoStart;
  $('useModel').checked = s.useModel;
  $('apiKey').value = s.apiKey;
  $('models').value = s.models.join('\n');
  const { usage, stats } = await chrome.storage.local.get(['usage', 'stats']);
  if (usage && usage.day === new Date().toISOString().slice(0, 10)) $('usage').textContent = Object.entries(usage.calls).map(([m, n]) => `${m}: ${n}`).join(', ');
  if (stats && stats.picks) {
    const f = (x) => (x / stats.picks).toFixed(1);
    $('stats').textContent = `${stats.picks} picks · ${f(stats.steps)} steps each (row-column scanning would take ${f(stats.rc)}, one-by-one ${f(stats.lin)})`;
  }
}

const save = (patch) => chrome.storage.local.set(patch);
for (const id of ['scanMs', 'laps']) $(id).addEventListener('change', (e) => save({ [id]: +e.target.value }));
$('order').addEventListener('change', (e) => save({ order: e.target.value }));
for (const id of ['autoStart', 'useModel']) $(id).addEventListener('change', (e) => save({ [id]: e.target.checked }));
$('apiKey').addEventListener('change', (e) => save({ apiKey: e.target.value.trim() }));
$('models').addEventListener('change', (e) => save({ models: e.target.value.split(/\s+/).filter(Boolean) }));

function capture(btn, field, show) {
  btn.addEventListener('click', () => {
    btn.textContent = 'Press your switch now…';
    addEventListener('keydown', function once(e) {
      e.preventDefault();
      removeEventListener('keydown', once, true);
      save({ [field]: e.code });
      show.textContent = e.code;
      btn.textContent = 'Press to set…';
    }, true);
  });
}
capture($('captureSwitch'), 'switchKey', $('switchKeyShow'));
capture($('captureNext'), 'nextKey', $('nextKeyShow'));
$('clearNext').addEventListener('click', () => {
  save({ nextKey: '' });
  $('nextKeyShow').textContent = '(none)';
});

$('test').addEventListener('click', async () => {
  const out = $('testOut');
  out.className = '';
  out.textContent = 'Checking…';
  try {
    const models = await listModels($('apiKey').value.trim());
    const wanted = $('models').value.split(/\s+/).filter(Boolean);
    const have = wanted.filter((m) => models.includes(m));
    out.className = 'ok';
    out.textContent = `Key works. ${have.length} of your ${wanted.length} models are available.`;
  } catch (e) {
    out.className = 'err';
    out.textContent = 'Key failed: ' + e.message;
  }
});

$('clearHistory').addEventListener('click', async () => {
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith('hist:')));
  $('clearOut').textContent = 'Done.';
});

load();
