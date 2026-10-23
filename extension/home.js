// Home page (replaces New Tab): Chrome's own New Tab page can't run
// extensions, so a switch user who opens a tab would be stuck there.

const tiles = document.getElementById('tiles');

function tile(url, title) {
  const a = document.createElement('a');
  a.className = 'tile';
  a.href = url;
  const host = new URL(url).hostname.replace(/^www\./, '');
  const icon = document.createElement('img');
  // Chrome's local favicon cache: no request leaves the browser.
  icon.src = chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=64`);
  icon.alt = '';
  icon.width = icon.height = 28;
  icon.onerror = () => icon.replaceWith(Object.assign(document.createElement('span'), { className: 'letter', textContent: host[0].toUpperCase() }));
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = title || host;
  name.title = title || host;
  a.append(icon, name);
  return a;
}

async function load() {
  const seen = new Set();
  const out = [];
  // Sites where this user picks the most things first, then Chrome's top sites.
  const all = await chrome.storage.local.get(null);
  const mine = Object.entries(all)
    .filter(([k]) => k.startsWith('hist:') && k !== 'hist:home')
    .map(([k, h]) => [k.slice(5), Object.values(h.site || {}).reduce((s, x) => s + x.n, 0)])
    .sort((a, b) => b[1] - a[1]);
  for (const [host] of mine) out.push({ url: `https://${host}/`, title: host.replace(/^www\./, '') });
  try {
    for (const t of await chrome.topSites.get()) out.push({ url: t.url, title: t.title });
  } catch {}
  for (const t of out) {
    if (!/^https?:/.test(t.url)) continue; // chrome:// and extension pages can't be scanned
    const host = new URL(t.url).hostname;
    if (seen.has(host)) continue;
    seen.add(host);
    tiles.append(tile(t.url, t.title));
    if (seen.size >= 12) break;
  }
  document.getElementById('empty').hidden = seen.size > 0;
}

document.getElementById('search').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = document.getElementById('q').value.trim();
  if (!t) return;
  location.href = /^\S+\.[a-z]{2,}(\/\S*)?$/i.test(t) ? (/^https?:/i.test(t) ? t : 'https://' + t) : 'https://www.google.com/search?q=' + encodeURIComponent(t);
});

load();
