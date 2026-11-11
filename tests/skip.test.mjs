// Skip-timing tests for content.js with a fake clock and a fake player.
// The skip must move on exactly one song: no extra seek once Next or a
// dislike has already changed the song (upstream issue #3: "the following
// two songs are also skipped"), and no jump to 99999 s on a video that has
// not loaded yet (that leaves the new player stuck at 0:00 / 0:00).
// Run from the repo root: node tests/skip.test.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const code = fs.readFileSync(path.join(root, 'content.js'), 'utf8');

function el(name, text = '', attrs = {}) {
  const e = {
    name, textContent: text, attrs: { ...attrs }, children: [], parentNode: null, clicks: 0, style: {}, onClick: null,
    getAttribute: k => (k in e.attrs ? e.attrs[k] : null),
    setAttribute: (k, v) => { e.attrs[k] = String(v); },
    dispatchEvent: ev => { if (ev.type === 'click') { e.clicks++; if (e.onClick) e.onClick(); } },
    querySelector: sel => (sel === 'button' ? e.children.find(c => c.name === 'button') || null : null),
    appendChild: c => { c.parentNode = e; e.children.push(c); return c; },
  };
  return e;
}

function clock() {
  let now = 0, id = 0;
  const timers = new Map();
  const add = (fn, ms, every) => { const t = ++id; timers.set(t, { at: now + Math.max(0, Number(ms) || 0), fn, every }); return t; };
  return {
    setTimeout: (fn, ms) => add(fn, ms, 0),
    setInterval: (fn, ms) => add(fn, ms, Math.max(1, Number(ms) || 0)),
    clear: t => { timers.delete(t); },
    tick(ms) {
      const end = now + ms;
      for (;;) {
        let due = null;
        for (const [k, t] of timers) if (t.at <= end && (!due || t.at < due[1].at)) due = [k, t];
        if (!due) break;
        const [k, t] = due;
        now = t.at;
        if (t.every) t.at += t.every; else timers.delete(k);
        t.fn();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

// nextAdvances: clicking Next changes the song. dislikeAdvances: YouTube Music
// moves on by itself after a dislike. duration: NaN = media not loaded yet.
function player({ nextAdvances = true, hasNext = true, duration = 200, dislikeAdvances = false, keyAdvances = false } = {}) {
  const title = el('div', 'Dust on the Wind');
  const byline = el('div', 'The Velvet Sundown • Floating on Echoes • 2025');
  const advance = () => { title.textContent = 'Song Two'; byline.textContent = 'Real Artist • Album'; };
  const next = el('button', '', { 'aria-label': 'Next' });
  next.onClick = () => { if (nextAdvances) advance(); };
  const dis = el('dislike-button-view-model');
  const disBtn = dis.appendChild(el('button', '', { 'aria-label': 'Dislike this video', 'aria-pressed': 'false' }));
  disBtn.onClick = () => { disBtn.setAttribute('aria-pressed', 'true'); if (dislikeAdvances) advance(); };
  const vid = {
    duration, ended: false, seeks: [], _t: 3,
    get currentTime() { return this._t; },
    set currentTime(x) { this._t = x; this.seeks.push(x); },
  };
  const m = {
    'ytmusic-miniplayer': el('ytmusic-miniplayer'),
    'ytmusic-miniplayer .ytmusicTrackInfoTitle': title,
    'ytmusic-miniplayer .ytmusicTrackInfoByline': byline,
    'ytmusic-miniplayer dislike-button-view-model': dis,
    video: vid,
  };
  if (hasNext) m['ytmusic-miniplayer button[aria-label="Next"]'] = next;
  // YouTube Music's own shortcut: "j" plays the next song, in any page language.
  const keys = [];
  const body = { dispatchEvent: ev => { keys.push(ev); if (ev.type === 'keydown' && ev.key === 'j' && keyAdvances) advance(); return true; } };
  return { m, next, disBtn, vid, title, keys, body };
}

async function load(opts = {}, local = {}) {
  const P = player(opts);
  const C = clock();
  const document = {
    readyState: 'loading', addEventListener() {}, body: P.body,
    querySelector: sel => {
      for (const part of sel.split(',').map(s => s.trim())) if (P.m[part]) return P.m[part];
      return null;
    },
    getElementById: () => null,
    createElement: name => el(name),
  };
  const ctx = {
    console: { log() {}, warn() {} }, window: {}, document,
    setTimeout: C.setTimeout, setInterval: C.setInterval, clearTimeout: C.clear, clearInterval: C.clear,
    MutationObserver: class { observe() {} disconnect() {} },
    MouseEvent: class { constructor(type) { this.type = type; } },
    KeyboardEvent: class { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } },
    fetch: async () => ({ ok: false }),
    chrome: { storage: { local: { get: async () => local, set: async () => {} }, onChanged: { addListener() {} } } },
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  await vm.runInContext('updateBlockList()', ctx);
  vm.runInContext('checkAndSkip()', ctx); // the playing song is by a blocked artist
  return { P, C };
}

const blocked = { blockedArtists: ['The Velvet Sundown'] };
const no99999 = vid => !vid.seeks.some(x => x >= 99999) || `jumped to ${vid.seeks.join(', ')}`;
const cases = [];

cases.push(['skip only, Next moves on: no seek afterwards (issue #3)', async () => {
  const { P, C } = await load({ nextAdvances: true }, blocked);
  C.tick(10000);
  return (P.next.clicks === 1 && P.vid.seeks.length === 0) || `Next clicks = ${P.next.clicks}, seeks = [${P.vid.seeks}]`;
}]);

cases.push(['skip only, Next ignored, video loaded: no seek in the first 1000 ms, then one seek to the end by 3000 ms', async () => {
  const { P, C } = await load({ nextAdvances: false, duration: 200 }, blocked);
  C.tick(1000);
  if (P.vid.seeks.length) return `seeked at <=1000 ms: [${P.vid.seeks}]`;
  C.tick(2000);
  return (P.vid.seeks.length === 1 && P.vid.seeks[0] === 200) || `seeks = [${P.vid.seeks}]`;
}]);

cases.push(['skip only, Next ignored, video loads at 2000 ms: never jumps to 99999, seeks to the end once loaded', async () => {
  const { P, C } = await load({ nextAdvances: false, duration: NaN }, blocked);
  C.tick(2000);
  const early = no99999(P.vid);
  if (early !== true) return early;
  if (P.vid.seeks.length) return `seeked before load: [${P.vid.seeks}]`;
  P.vid.duration = 180;
  C.tick(3000);
  return (P.vid.seeks.length === 1 && P.vid.seeks[0] === 180) || `seeks = [${P.vid.seeks}]`;
}]);

cases.push(['skip only, Next ignored, video never loads: never seeks, stops polling within 10 s', async () => {
  const { P, C } = await load({ nextAdvances: false, duration: NaN }, blocked);
  C.tick(10000);
  return (P.vid.seeks.length === 0 && C.pending() === 0) || `seeks = [${P.vid.seeks}], timers still pending = ${C.pending()}`;
}]);

cases.push(['skip only, no Next button found: seeks to the end once, by 3000 ms', async () => {
  const { P, C } = await load({ hasNext: false, duration: 200 }, blocked);
  C.tick(3000);
  return (P.vid.seeks.length === 1 && P.vid.seeks[0] === 200) || `seeks = [${P.vid.seeks}]`;
}]);

cases.push(['dislike on, the dislike itself moves on: no Next click, no seek (issue #3)', async () => {
  const { P, C } = await load({ dislikeAdvances: true }, { ...blocked, dislikeBlocked: true });
  C.tick(10000);
  return (P.disBtn.clicks === 1 && P.next.clicks === 0 && P.vid.seeks.length === 0)
    || `Dislike clicks = ${P.disBtn.clicks}, Next clicks = ${P.next.clicks}, seeks = [${P.vid.seeks}]`;
}]);

cases.push(['dislike on, the song stays after the dislike: Next clicked once, no seek', async () => {
  const { P, C } = await load({ dislikeAdvances: false, nextAdvances: true }, { ...blocked, dislikeBlocked: true });
  C.tick(10000);
  return (P.disBtn.clicks === 1 && P.next.clicks === 1 && P.vid.seeks.length === 0)
    || `Dislike clicks = ${P.disBtn.clicks}, Next clicks = ${P.next.clicks}, seeks = [${P.vid.seeks}]`;
}]);

cases.push(['skip only, song moves on late (after the seek is due) with the next song loaded: no seek', async () => {
  const { P, C } = await load({ nextAdvances: false, duration: NaN }, blocked);
  C.tick(2500); // past the 1.5 s point, video still not loaded
  P.title.textContent = 'Song Two'; // YouTube Music moves on late
  P.vid.duration = 200; // and the next song's video has loaded
  C.tick(10000);
  return P.vid.seeks.length === 0 || `seeks = [${P.vid.seeks}] (the next song was skipped)`;
}]);

cases.push(['dislike on, neither the dislike nor Next moves on: one Next click, then one seek to the end', async () => {
  const { P, C } = await load({ dislikeAdvances: false, nextAdvances: false, duration: 200 }, { ...blocked, dislikeBlocked: true });
  C.tick(10000);
  return (P.next.clicks === 1 && P.vid.seeks.length === 1 && P.vid.seeks[0] === 200)
    || `Next clicks = ${P.next.clicks}, seeks = [${P.vid.seeks}]`;
}]);

const jDowns = P => P.keys.filter(e => e.type === 'keydown' && e.key === 'j').length;

cases.push(['skip only, no Next button (non-English page): presses "j" on the page once; it moves on, so no seek', async () => {
  const { P, C } = await load({ hasNext: false, keyAdvances: true, duration: 200 }, blocked);
  const pressedAtOnce = jDowns(P);
  C.tick(10000);
  const k = P.keys.find(e => e.type === 'keydown');
  return (pressedAtOnce === 1 && jDowns(P) === 1 && k.code === 'KeyJ' && k.bubbles === true && P.vid.seeks.length === 0)
    || `j keydowns at once = ${pressedAtOnce}, total = ${jDowns(P)}, code = ${k && k.code}, bubbles = ${k && k.bubbles}, seeks = [${P.vid.seeks}]`;
}]);

cases.push(['skip only, Next button found: clicks it and does not also press "j" (no double skip)', async () => {
  const { P, C } = await load({ nextAdvances: true, keyAdvances: true }, blocked);
  C.tick(10000);
  return (P.next.clicks === 1 && jDowns(P) === 0) || `Next clicks = ${P.next.clicks}, j keydowns = ${jDowns(P)}`;
}]);

let fail = 0;
for (const [label, fn] of cases) {
  let r;
  try { r = await fn(); } catch (e) { r = `threw ${e.message}`; }
  if (r !== true) fail++;
  console.log(`${r === true ? 'PASS' : 'FAIL'}  ${label}${r === true ? '' : `  (${r})`}`);
}
console.log(`\n${cases.length - fail}/${cases.length} pass`);
process.exit(fail ? 1 : 0);
