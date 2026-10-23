// Service worker: model calls (keeps the API key out of web pages), the
// per-tab trail of pages, and the toggle shortcut.

import { rankElements, suggestText, DEFAULT_MODELS } from './core/llm.js';

// Per-tab state lives in session storage: the worker is stopped when idle.
async function tabState(tabId) {
  const k = 't:' + tabId;
  return (await chrome.storage.session.get(k))[k] || { trail: [], goal: '' };
}
async function setTabState(tabId, st) {
  await chrome.storage.session.set({ ['t:' + tabId]: st });
}

async function settings() {
  const s = await chrome.storage.local.get(['apiKey', 'models', 'useModel']);
  return { apiKey: s.apiKey || '', models: s.models?.length ? s.models : DEFAULT_MODELS, useModel: s.useModel !== false };
}

async function cached(key, make) {
  const k = 'c:' + key;
  const hit = (await chrome.storage.session.get(k))[k];
  if (hit) return { ...hit, cached: true };
  const val = await make();
  await chrome.storage.session.set({ [k]: val });
  return val;
}

async function countCall(model) {
  const day = new Date().toISOString().slice(0, 10);
  const { usage = {} } = await chrome.storage.local.get('usage');
  if (usage.day !== day) Object.assign(usage, { day, calls: {} });
  usage.calls[model] = (usage.calls[model] || 0) + 1;
  await chrome.storage.local.set({ usage });
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tabId = sender.tab?.id;
  (async () => {
    const st = await tabState(tabId);
    if (msg.type === 'page') {
      if (st.trail.at(-1) !== msg.title) st.trail = [...st.trail, msg.title].slice(-6);
      await setTabState(tabId, st);
      return { goal: st.goal };
    }
    if (msg.type === 'goal') {
      st.goal = msg.goal || '';
      await setTabState(tabId, st);
      return { goal: st.goal };
    }
    const s = await settings();
    if (!s.useModel || !s.apiKey) return { error: 'off' };
    if (msg.type === 'rank') {
      const trail = st.trail.slice(0, -1);
      const key = JSON.stringify([msg.url, st.goal, msg.elements.map((e) => e.label).join('\u0001')]);
      return cached(key, async () => {
        const r = await rankElements({ ...msg, goal: st.goal, trail, apiKey: s.apiKey, models: s.models });
        countCall(r.model);
        return r;
      });
    }
    if (msg.type === 'suggest') {
      const key = JSON.stringify([msg.url, st.goal, msg.field, msg.typed.toLowerCase()]);
      return cached(key, async () => {
        const r = await suggestText({ ...msg, goal: st.goal, apiKey: s.apiKey, models: s.models });
        countCall(r.model);
        return r;
      });
    }
    return { error: 'unknown' };
  })()
    .then(reply)
    .catch((e) => reply({ error: String(e.message || e) }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove('t:' + tabId));

async function toggle(tab) {
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
  } catch {
    // Page loaded before the extension (or a page scripts can't run on).
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['core/tree.js', 'core/priors.js', 'core/words.js', 'content.js'] }).catch(() => {});
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' }).catch(() => {});
  }
}

chrome.action.onClicked.addListener(toggle);
chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd === 'toggle-scanning') toggle((await chrome.tabs.query({ active: true, currentWindow: true }))[0]);
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
});
