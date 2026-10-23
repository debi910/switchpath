// Free-tier language model calls (Google AI Studio key, no card needed).
//
// Two jobs:
//   rankElements  which on-screen elements is the user likely to pick next,
//                 given the page, the pages they came through, and their goal
//   suggestText   what they probably want to type into the focused field
//
// Free tiers cap requests per model per day, so calls walk a chain of fast
// models and skip any model that just answered 429/503 for a while. Answers
// are cached by the caller.

export const DEFAULT_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-flash-lite-latest', 'gemini-3-flash-preview', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemma-4-31b-it'];

const cooldownUntil = new Map();

export async function generateJSON({ apiKey, models = DEFAULT_MODELS, system, prompt, timeoutMs = 12000, fetchImpl = fetch }) {
  if (!apiKey) throw new Error('No API key');
  let lastErr = null;
  for (const model of models) {
    if ((cooldownUntil.get(model) || 0) > Date.now()) continue;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: model.startsWith('gemma') ? undefined : { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: model.startsWith('gemma') ? `${system}\n\n${prompt}` : prompt }] }],
          generationConfig: model.startsWith('gemma') ? {} : { responseMimeType: 'application/json', temperature: 0.2 },
        }),
      }).finally(() => clearTimeout(timer));
      if (res.status === 429 || res.status === 503 || res.status === 404 || res.status === 500) {
        // Over the per-minute or daily quota, overloaded, or not offered to
        // this key. 429s say how long to wait.
        let wait = { 429: 60e3, 503: 30e3, 500: 30e3, 404: 24 * 3600e3 }[res.status];
        if (res.status === 429) {
          const body = await res.json().catch(() => ({}));
          const delay = (body.error?.details || []).find((d) => d.retryDelay)?.retryDelay;
          if (delay) wait = Math.max(5e3, parseFloat(delay) * 1000);
          if (/per day|PerDay/i.test(JSON.stringify(body))) wait = 3600e3;
        }
        cooldownUntil.set(model, Date.now() + wait);
        lastErr = new Error(`${model}: ${res.status}`);
        continue;
      }
      if (!res.ok) throw new Error(`${model}: ${res.status} ${(await res.text()).slice(0, 200)}`);
      const body = await res.json();
      const parts = body.candidates?.[0]?.content?.parts || [];
      const text = parts.filter((p) => !p.thought).map((p) => p.text || '').join('');
      return { model, json: parseLoose(text) };
    } catch (e) {
      lastErr = e;
      if (e.name === 'AbortError') cooldownUntil.set(model, Date.now() + 60e3);
    }
  }
  const err = lastErr || new Error('All models are cooling down');
  err.retryAt = Math.min(...models.map((m) => cooldownUntil.get(m) || 0));
  throw err;
}

// Models sometimes wrap JSON in fences or add text around it.
function parseLoose(text) {
  const a = Math.min(...['{', '['].map((c) => text.indexOf(c)).filter((i) => i >= 0));
  const b = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (!isFinite(a) || b < a) return null;
  try {
    return JSON.parse(text.slice(a, b + 1));
  } catch {
    return null;
  }
}

const RANK_SYSTEM = `You help a person with a severe motor disability browse the web with a single switch. Every extra choice costs them seconds, so good predictions of their next click matter.
You get the page, the pages they just came through, optionally their goal, and the numbered clickable elements on screen.
Estimate which elements they will pick next. Give probabilities that reflect real uncertainty (they sum to at most 1; leave the rest for elements you did not list).
"Scroll down" and "Back" are valid choices when the thing they need is probably off screen or behind them.
Answer only JSON: {"ranked":[{"id":<number>,"p":<probability>}, ...]} with at most 8 entries, most likely first.`;

export function rankPrompt({ url, title, trail = [], goal = '', elements }) {
  const lines = elements.map((e) => `${e.id}. [${e.kind}] ${e.label}${e.region ? ` (${e.region})` : ''}`);
  return [
    `Page: ${title || '(untitled)'}\nURL: ${url}`,
    trail.length ? `Came through: ${trail.slice(-5).join(' > ')}` : '',
    goal ? `Their goal: ${goal}` : 'They have not said what they want; predict what this user is most likely to do here.',
    `Elements:\n${lines.join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

// -> {index: probability} keyed by the caller's element index.
export async function rankElements({ apiKey, models, url, title, trail, goal, elements }) {
  const shown = elements.slice(0, 160);
  // A late ranking still helps (it applies at the next pass), so wait longer
  // than for typing suggestions: free models can be slow at busy times.
  const { model, json } = await generateJSON({ apiKey, models, system: RANK_SYSTEM, prompt: rankPrompt({ url, title, trail, goal, elements: shown }), timeoutMs: 20000 });
  const out = {};
  const ranked = Array.isArray(json) ? json : json?.ranked || [];
  for (const r of ranked) {
    const id = +r.id;
    const p = +r.p;
    if (shown.some((e) => e.id === id) && p > 0) out[id] = Math.min(1, p);
  }
  const t = Object.values(out).reduce((a, b) => a + b, 0);
  if (t > 1) for (const k in out) out[k] /= t;
  return { model, probs: out };
}

const TEXT_SYSTEM = `You help a person with a severe motor disability type into web forms with a single switch, one letter at a time, so each letter costs seconds.
Given the page, the field, their goal and what they typed so far, suggest the complete text they most likely want in this field.
Every suggestion must start with exactly what they typed so far (case-insensitive). Short, plausible, varied, most likely first.
Answer only JSON: {"suggestions":["...", ...]} with at most 5 entries.`;

export async function suggestText({ apiKey, models, url, title, goal, field, typed }) {
  const prompt = [`Page: ${title}\nURL: ${url}`, goal ? `Their goal: ${goal}` : '', `Field: ${field || 'text box'}`, `Typed so far: "${typed}"`].filter(Boolean).join('\n');
  const { model, json } = await generateJSON({ apiKey, models, system: TEXT_SYSTEM, prompt, timeoutMs: 8000 });
  const list = (Array.isArray(json) ? json : json?.suggestions || []).filter((s) => typeof s === 'string');
  const lc = typed.toLowerCase();
  // Models sometimes return only the word being typed ("milk" for "buy m"):
  // put the earlier words back in front.
  const head = typed.slice(0, typed.length - (typed.match(/\S*$/) || [''])[0].length);
  const fixed = list.map((s) => (s.toLowerCase().startsWith(lc) || !(head + s).toLowerCase().startsWith(lc) ? s : head + s));
  return { model, suggestions: [...new Set(fixed)].filter((s) => s.toLowerCase().startsWith(lc) && s.length > typed.length).slice(0, 5) };
}

export async function listModels(apiKey) {
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': apiKey } });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { models = [] } = await res.json();
  return models
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent') && /gemini|gemma/.test(m.name))
    .filter((m) => !/image|tts|audio|live|embedding|vision|transcribe|robotics|computer-use|research|lyria|banana|omni|customtools/.test(m.name))
    .map((m) => m.name.replace(/^models\//, ''));
}
