'use strict';
// Hands-free Tasbeeh. Counts recitations by their rhythm: each phrase is a burst of voice followed by a pause.
// Nothing leaves the phone: the microphone is only used to measure loudness, 50 times a second.

// Bump on every deploy. The page compares it with the live copy when it opens or comes back to the foreground,
// because phones resume home-screen apps from memory instead of reloading them.
const APP_VERSION = 'b1';
// Recordings not trimmed into this repo stream from the Hisn al-Muslim collection, pinned to one commit
const AUDIO_CDN = 'https://cdn.jsdelivr.net/gh/rn0x/Adhkar-json@93dc3fc489e4291da8816265920b3cb7e2c3b569/audio/';
const ROOT = location.pathname.includes('/beta/') ? '../' : './'; // the repo's audio/ and icons live at the site root
const SHARE_URL = new URL(ROOT, location.href).href;

const $ = id => document.getElementById(id);
const { P, CATS } = window.ADHKAR;

// ---------- storage (namespaced so the old app on the same site keeps working) ----------
const NS = 'tb2.';
function load(k, d) { try { const v = localStorage.getItem(NS + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
function save(k, v) { try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch (e) {} }
try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}

const DEFAULTS = { sens: 55, gap: 260, split: true, vib: true, click: false, wake: true, showTr: true, showEn: true, auto: true };
const S = Object.assign({}, DEFAULTS, load('settings', {}));
const saveSettings = () => save('settings', S);
// voice: learned pace. rate = ms of voice per Arabic letter; T = learned ms per recitation, per dhikr
const V = Object.assign({ rate: 62, T: {} }, load('voice', {}));
const saveVoice = () => save('voice', V);

// ---------- dhikr list ----------
const custom = load('custom', []);
function customItem(c) { return { ar: c.ar || '', name: c.name, tr: '', en: c.en || '', ref: '', src: 'Your own', custom: true }; }
for (const c of custom) P['c' + c.id] = customItem(c);
const ALLCATS = CATS.concat([{ id: 'mine', group: 'Yours', name: 'My adhkar', items: custom.map(c => ['c' + c.id, c.n]) }]);
let E = []; // flat list of entries: one per (category, dhikr)
function buildEntries() {
  E = [];
  for (const c of ALLCATS) for (const [k, n] of c.items) if (P[k]) E.push({ key: c.id + '|' + k, cat: c.id, k, n });
}
buildEntries();
const catOf = id => ALLCATS.find(c => c.id === id);
const entriesOf = id => E.filter(e => e.cat === id);
const letters = s => (s || '').replace(/[^ء-ي]/g, '').length;

// ---------- daily progress & history ----------
const dk = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const addDays = (k, n) => { const [y, m, d] = k.split('-').map(Number); return dk(new Date(y, m - 1, d + n)); };
let today = dk(new Date());
let st = load('state', { day: today, c: {}, n: {}, sel: null });
let history = load('history', null);
if (!history) { // first run: bring over the old app's history so streaks carry on
  history = {};
  try {
    const old = JSON.parse(localStorage.getItem('history') || '{}') || {};
    for (const [d, h] of Object.entries(old)) if (/^\d{4}-\d\d-\d\d$/.test(d) && h && h.t) {
      const c = {}; for (const [key, n] of Object.entries(h.c || {})) { const name = key.slice(key.indexOf('|') + 1); c[name] = (c[name] || 0) + n; }
      history[d] = { t: h.t, c, d: h.d || [] };
    }
  } catch (e) {}
  save('history', history);
}
if (st.day !== today) st = { day: today, c: {}, n: st.n || {}, sel: st.sel };
const count = e => st.c[e.key] || 0;
const target = e => st.n[e.key] || e.n;
const isDone = e => count(e) >= target(e);
const nameOf = k => P[k] ? P[k].name : k;

function saveState() {
  save('state', st);
  const c = {}; let t = 0;
  for (const e of E) { const n = count(e); if (n) { const nm = nameOf(e.k); c[nm] = (c[nm] || 0) + n; t += n; } }
  const d = ALLCATS.filter(k => k.items.length && entriesOf(k.id).every(isDone)).map(k => k.id);
  if (t) history[today] = { t, c, d }; else delete history[today];
  const keys = Object.keys(history).sort(); for (const k of keys.slice(0, Math.max(0, keys.length - 800))) delete history[k];
  save('history', history);
}
function checkDay() {
  const d = dk(new Date()); if (d === today) return;
  today = d; st = { day: d, c: {}, n: st.n, sel: st.sel }; saveState(); render();
}

// ---------- current entry ----------
let cur = Math.max(0, E.findIndex(e => e.key === st.sel));
const E0 = () => E[cur];
function select(i, quiet) {
  if (i < 0 || i >= E.length) return;
  sayStop();
  cur = i; st.sel = E[i].key; save('state', st);
  det && det.retime(expectedMs(E[i].k));
  render();
  if (!quiet && listening) setStatus('Listening. Recite <b>' + esc(nameOf(E[i].k)) + '</b>.');
}
function step(dir) {
  const c = E0().cat, list = entriesOf(c), j = list.indexOf(E0()) + dir;
  if (j >= 0 && j < list.length) select(E.indexOf(list[j]));
}

// ---------- rendering ----------
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function render() {
  const e = E0(), p = P[e.k], cat = catOf(e.cat), list = entriesOf(e.cat), pos = list.indexOf(e);
  $('catName').textContent = cat.name;
  $('pos').textContent = (pos + 1) + ' of ' + list.length + (hijri ? ' · ' + hijri : '');
  $('eyebrow').textContent = p.name;
  const ar = $('ar'), L = letters(p.ar);
  ar.textContent = p.ar || p.name;
  ar.lang = p.ar ? 'ar' : 'en'; ar.dir = p.ar ? 'rtl' : 'ltr';
  ar.className = 'ar' + (p.quran || /[ۖ-ۭ]/.test(p.ar) ? ' q' : '') + (L > 110 ? ' l' : L > 36 ? ' m' : '');
  $('tr').textContent = S.showTr ? p.tr || '' : ''; $('tr').hidden = !S.showTr || !p.tr;
  $('en').textContent = S.showEn ? p.en || '' : ''; $('en').hidden = !S.showEn || !p.en;
  $('note').textContent = p.note || ''; $('note').hidden = !p.note;
  $('say').hidden = !audioUrls(p);
  $('infoBtn').hidden = !(p.ref || p.why);
  $('prev').disabled = pos <= 0; $('next').disabled = pos >= list.length - 1;
  $('scroll').scrollTop = 0;
  requestAnimationFrame(() => $('scroll').classList.toggle('fits', $('scroll').scrollHeight <= $('scroll').clientHeight + 2));
  drawCount();
  if (drawerOpen() || wide.matches) renderList();
}
let lastLit = -1;
function drawCount(bump) {
  const e = E0(), c = count(e), n = target(e);
  $('num').textContent = c;
  const rounds = Math.floor(c / n);
  $('of').textContent = c >= n && n > 1 ? (c === n ? 'done' : 'of ' + n + ' · ' + (rounds + 1) + (rounds === 1 ? 'nd' : rounds === 2 ? 'rd' : 'th') + ' round') : n === 1 ? (c ? 'done' : 'once') : 'of ' + n;
  $('ring').classList.toggle('done', c >= n);
  $('ring').setAttribute('aria-label', 'Count one. ' + c + ' of ' + n);
  // a misbaha of up to 33 beads; for bigger targets each bead stands for several counts
  const N = n === 1 ? 0 : n <= 40 ? n : 33, per = n / (N || 1);
  const within = c >= n && c % n === 0 && c > 0 ? n : c % n;
  const lit = Math.min(N, Math.floor(within / per + 1e-9));
  const svg = $('beads');
  if (svg.dataset.n !== String(N)) {
    const R = 128, r = Math.max(4.5, Math.min(13, Math.PI * R / N * 0.62));
    // a single dua has no beads: the cord itself fills when it's done
    let h = '<circle class="cord' + (N ? '' : ' whole') + '" cx="150" cy="150" r="' + R + '"/><ellipse class="imam" cx="150" cy="' + (150 - R) + '" rx="' + (r * 0.75) + '" ry="' + (r * 1.35) + '"/>';
    for (let i = 0; i < N; i++) {
      const a = -Math.PI / 2 + (i + 1) * (2 * Math.PI) / (N + 1);
      h += '<circle class="b" cx="' + (150 + R * Math.cos(a)).toFixed(1) + '" cy="' + (150 + R * Math.sin(a)).toFixed(1) + '" r="' + r.toFixed(1) + '"/>';
    }
    svg.innerHTML = h; svg.dataset.n = N; lastLit = -1;
  }
  const bs = svg.querySelectorAll('.b');
  bs.forEach((b, i) => { b.classList.toggle('lit', i < lit); b.classList.remove('new'); });
  if (bump && lit > 0 && lit !== lastLit) { const b = bs[lit - 1]; void b.getBoundingClientRect(); b.classList.add('new'); }
  lastLit = lit;
}

// ---------- counting ----------
let lastAdd = null; // {key, k, n, voice, ms}
function add(k, how) {
  if (!k) return;
  checkDay();
  const e = E0(), was = count(e);
  const v = Math.max(0, was + k);
  if (v === was) return;
  st.c[e.key] = v; saveState();
  if (k > 0) { lastAdd = { key: e.key, n: k, how }; feedback(); }
  drawCount(k > 0);
  if (drawerOpen() || wide.matches) renderList();
  if (k > 0 && was < target(e) && v >= target(e)) reached(e);
}
function reached(e) {
  try { S.vib && navigator.vibrate && navigator.vibrate([90, 60, 90]); } catch (x) {}
  const list = entriesOf(e.cat);
  if (S.auto) {
    const i = list.indexOf(e), next = list.slice(i + 1).find(x => !isDone(x)) || list.find(x => !isDone(x));
    if (next) {
      setStatus('Done. Next: <b>' + esc(nameOf(next.k)) + '</b>');
      setTimeout(() => { if (E0() === e) select(E.indexOf(next), true); }, 700);
      return;
    }
  }
  if (list.every(isDone)) { setStatus('All of ' + esc(catOf(e.cat).name) + ' done today. May Allah accept it.'); toast('Masha’Allah, list complete'); }
  else setStatus('Done.');
}
let clickCtx = null;
function feedback() {
  try { S.vib && navigator.vibrate && navigator.vibrate(25); } catch (e) {}
  if (S.click) {
    try { // a short wooden tick, synthesised so it needs no file
      const c = ctx || (clickCtx = clickCtx || new (window.AudioContext || window.webkitAudioContext)());
      const o = c.createOscillator(), g = c.createGain(), t = c.currentTime;
      o.type = 'triangle'; o.frequency.setValueAtTime(1300, t); o.frequency.exponentialRampToValueAtTime(500, t + 0.05);
      g.gain.setValueAtTime(0.18, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
      o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + 0.08);
      muteUntil = performance.now() + 140; // don't let the tick count itself
    } catch (e) {}
  }
}

// ---------- the rhythm detector ----------
// Pure logic: fed one loudness reading (dBFS) per frame, returns how many recitations just finished.
// A recitation is voiced time followed by a pause. Short dips inside a phrase are bridged; voiced time is added
// up until it reaches about half the expected length, so long duas with breaths in them still count once.
class Rhythm {
  constructor(o) { this.o = Object.assign({ sens: 11, gap: 260, T: 650, minMs: 160, split: true }, o); this.reset(); }
  reset() { this.floor = null; this.init = []; this.on = false; this.lastLoud = 0; this.runStart = 0; this.voiced = 0; this.acc = 0; this.peak = -120; this.peaks = []; }
  retime(T) { this.o.T = T; this.acc = 0; this.voiced = 0; }
  thresholds() { return { on: this.floor + this.o.sens, off: this.floor + this.o.sens * 0.6 }; }
  push(db, ms, t) {
    if (this.floor == null) { // learn the room for the first 300 ms
      this.init.push(db); if (this.init.length < 15) return 0;
      const s = this.init.slice().sort((a, b) => a - b); this.floor = s[Math.floor(s.length * 0.4)]; return 0;
    }
    const th = this.thresholds(), loud = db > (this.on ? th.off : th.on);
    if (loud) {
      if (!this.on) { this.on = true; this.runStart = t; this.peak = -120; }
      this.voiced += ms; this.lastLoud = t; this.peak = Math.max(this.peak, db);
      if (t - this.runStart > 12000 && this.voiced > 10000) { // a steady sound (fan, traffic), not recitation: adopt it as background
        this.floor = db - 1; this.on = false; this.voiced = 0; this.acc = 0;
      }
      return 0;
    }
    if (this.on) {
      if (t - this.lastLoud < this.o.gap) return 0; // a short dip inside the phrase
      this.on = false; this.acc += this.voiced; this.voiced = 0; this.peaks.push(this.peak);
      if (this.peaks.length > 20) this.peaks.shift();
      return this.decide(false);
    }
    // quiet: follow the background down quickly and up slowly
    this.floor += (db - this.floor) * (db < this.floor ? 0.25 : 0.004);
    if (this.acc > 0 && t - this.lastLoud > this.longGap()) return this.decide(true);
    return 0;
  }
  // how long a silence ends a recitation for sure: short phrases have no breaths inside, long duas do
  longGap() { return Math.max(500, this.o.gap * 2.2, Math.min(1400, this.o.T * 0.25)); }
  decide(final) {
    const T = this.o.T, a = this.acc;
    // Short phrases have no breaths inside, so every pause ends one: count anything longer than a cough.
    // Long duas do have breaths, so after a normal pause wait for most of the expected length.
    const need = T <= 2500 ? Math.max(this.o.minMs, T * 0.35) : final ? T * 0.4 : T * 0.8;
    if (a < need) { if (final) { this.acc = 0; this.missed = a; } return 0; } // a cough or click, or a phrase still going
    this.acc = 0; this.last = a;
    if (!this.o.split || a < 1.75 * T) return 1;
    return Math.min(12, Math.round(a / T));
  }
}
const sensDb = () => 22 - S.sens * 0.17; // slider 0..100 → 22..5 dB above the background
function expectedMs(k) {
  if (V.T[k]) return V.T[k];
  const p = P[k], L = letters(p.ar) || Math.max(6, (p.name || '').replace(/[^A-Za-z]/g, '').length * 0.8);
  return Math.max(320, Math.min(20000, L * V.rate));
}
function learn(k, ms) { // recitations counted once teach the expected length, slowly
  const T0 = expectedMs(k), base = letters(P[k].ar) * V.rate || T0;
  V.T[k] = Math.round(Math.max(base * 0.4, Math.min(base * 2.5, T0 * 0.8 + ms * 0.2)));
  saveVoice();
}

// ---------- microphone ----------
let ctx = null, stream = null, node = null, src = null, listening = false, det = null, wake = null, muteUntil = 0, onFrame = null;
const WORKLET = `class L extends AudioWorkletProcessor{constructor(){super();this.s=0;this.n=0;this.N=Math.round(sampleRate*0.02)}
process(i){const c=i[0]&&i[0][0];if(c){for(let k=0;k<c.length;k++){this.s+=c[k]*c[k];if(++this.n>=this.N){this.port.postMessage(this.s/this.n);this.s=0;this.n=0}}}return true}}
registerProcessor('level',L)`;
async function openMic() {
  if (!window.isSecureContext) throw Object.assign(new Error('insecure'), { name: 'Insecure' });
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error('nomedia'), { name: 'NoMedia' });
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1 } });
  } catch (e) {
    if (e.name !== 'OverconstrainedError' && e.name !== 'TypeError') throw e;
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') await ctx.resume();
  src = ctx.createMediaStreamSource(stream);
  // keep the voice band, drop rumble and hiss
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 110;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3800;
  src.connect(hp); hp.connect(lp);
  const sink = ctx.createGain(); sink.gain.value = 0; sink.connect(ctx.destination);
  const frame = ms => { if (onFrame) onFrame(10 * Math.log10(ms + 1e-12), 20); };
  try {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    node = new AudioWorkletNode(ctx, 'level');
    node.port.onmessage = e => frame(e.data);
  } catch (e) { // older browsers: ScriptProcessor, cut into 20 ms frames
    node = ctx.createScriptProcessor(1024, 1, 1);
    const N = Math.round(ctx.sampleRate * 0.02); let s = 0, n = 0;
    node.onaudioprocess = ev => { const d = ev.inputBuffer.getChannelData(0); for (let i = 0; i < d.length; i++) { s += d[i] * d[i]; if (++n >= N) { frame(s / n); s = 0; n = 0; } } };
  }
  lp.connect(node); node.connect(sink);
  stream.getAudioTracks()[0].onended = () => { if (listening) stop('The microphone was turned off by the phone. Tap the microphone to start again.'); };
}
function closeMic() {
  try { node && (node.port ? node.port.onmessage = null : node.onaudioprocess = null); } catch (e) {}
  try { stream && stream.getTracks().forEach(t => t.stop()); } catch (e) {}
  try { ctx && ctx.close(); } catch (e) {}
  ctx = stream = node = src = null; onFrame = null;
}
async function keepAwake(on) {
  try {
    if (on && S.wake && 'wakeLock' in navigator && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); }
    if (!on && wake) { await wake.release(); wake = null; }
  } catch (e) { wake = null; }
}

let levelPeak = -120;
async function start() {
  const mic = $('mic');
  mic.classList.add('busy'); setStatus('Starting the microphone…');
  try {
    await openMic();
  } catch (e) {
    mic.classList.remove('busy'); closeMic(); micError(e); return;
  }
  mic.classList.remove('busy');
  det = new Rhythm({ sens: sensDb(), gap: S.gap, T: expectedMs(E0().k), split: S.split });
  listening = true; levelPeak = -120;
  mic.classList.add('on'); mic.setAttribute('aria-pressed', 'true'); mic.setAttribute('aria-label', 'Stop counting by voice');
  setStatus('Listening. Recite <b>' + esc(nameOf(E0().k)) + '</b>.');
  $('hint').textContent = 'Recite with a short breath between each one.';
  keepAwake(true);
  onFrame = (db, ms) => {
    const t = performance.now();
    if (saying || t < muteUntil) { det.on = false; det.voiced = 0; det.acc = 0; return; }
    const n = det.push(db, ms, t);
    meter(db);
    if (n) {
      const k = E0().k;
      if (det.last) { learn(k, det.last / n); det.o.T = expectedMs(k); }
      add(n, 'voice');
      if (n > 1) setStatus('Counted ' + n + ' run together.');
    }
  };
  try { save('micOk', true); } catch (e) {}
}
function stop(msg) {
  listening = false; closeMic(); keepAwake(false); det = null;
  const mic = $('mic'); mic.classList.remove('on'); mic.setAttribute('aria-pressed', 'false'); mic.setAttribute('aria-label', 'Start counting by voice');
  $('lv').style.transform = '';
  setStatus(typeof msg === 'string' ? msg : 'Stopped. Tap the microphone to carry on.');
  $('hint').textContent = 'Tap the beads to count, or tap the microphone and recite.';
}
let mT = 0;
function meter(db) {
  const now = performance.now(); if (now - mT < 50) return; mT = now;
  const th = det.thresholds(), x = Math.max(0, Math.min(1, (db - det.floor) / (th.on - det.floor + 8)));
  $('lv').style.transform = 'scale(' + (0.92 + x * 0.22).toFixed(3) + ')';
  $('lv').style.opacity = det.on ? 1 : 0.35 + x * 0.4;
}
$('mic').onclick = () => { listening ? stop() : start(); };
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  checkDay(); checkUpdate(); suggest();
  if (listening) {
    keepAwake(true);
    const dead = !stream || stream.getAudioTracks().every(t => t.readyState === 'ended');
    if (dead) { stop('Paused while the screen was off. Tap the microphone to carry on.'); return; }
    try { if (ctx && ctx.state !== 'running') await ctx.resume(); } catch (e) {}
  }
});

// ---------- environment & mic problems ----------
const UA = navigator.userAgent;
const IOS = /iPhone|iPad|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const ANDROID = /Android/.test(UA);
const STANDALONE = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function inAppBrowser() {
  const m = UA.match(/\b(FBAN|FBAV|FB_IAB|Instagram|Line\/|Snapchat|TikTok|musical_ly|Bytedance|Twitter|LinkedInApp|WhatsApp|Telegram|Pinterest|GSA\/)/);
  if (m) return ({ FBAN: 'Facebook', FBAV: 'Facebook', FB_IAB: 'Facebook', 'Line/': 'LINE', musical_ly: 'TikTok', Bytedance: 'TikTok', LinkedInApp: 'LinkedIn', 'GSA/': 'the Google app' })[m[1]] || m[1];
  if (ANDROID && /; wv\)/.test(UA)) return 'another app';
  if (IOS && !/Safari\//.test(UA) && !STANDALONE) return 'another app';
  return null;
}
const chromeIntent = () => 'intent://' + location.host + location.pathname + '#Intent;scheme=https;package=com.android.chrome;end';
function openElsewhereHtml(app) {
  const where = app ? 'inside ' + esc(app) : 'inside another app';
  if (ANDROID) return '<b class="t">Open this in Chrome for voice counting</b>You’re viewing it ' + where + ', which usually blocks the microphone.<div class="acts"><a class="btn sm main" href="' + chromeIntent() + '">Open in Chrome</a><button class="btn sm" data-copy>Copy link</button></div>';
  if (IOS) return '<b class="t">Open this in Safari for voice counting</b>You’re viewing it ' + where + ', which usually blocks the microphone. Tap <b>•••</b> or the share button and choose <b>Open in Safari</b>, or copy the link and paste it into Safari.<div class="acts"><button class="btn sm" data-copy>Copy link</button></div>';
  return '<b class="t">Open this in your browser for voice counting</b>You’re viewing it ' + where + ', which usually blocks the microphone.<div class="acts"><button class="btn sm" data-copy>Copy link</button></div>';
}
function micHelp(kind) {
  if (kind === 'denied') {
    if (IOS) return 'Microphone access is off for this site. In Safari tap <b>aA</b> in the address bar → <b>Website Settings</b> → <b>Microphone</b> → <b>Allow</b>. If it’s on the home screen, open the iPhone <b>Settings</b> app → <b>Safari</b> → <b>Microphone</b> → <b>Allow</b>. Then reload.';
    if (ANDROID) return 'Microphone access is blocked for this site. Tap the icon to the left of the address in Chrome → <b>Permissions</b> → <b>Microphone</b> → <b>Allow</b>. If that’s already on, check Android <b>Settings</b> → <b>Apps</b> → <b>Chrome</b> → <b>Permissions</b> → <b>Microphone</b>. Then reload.';
    return 'Microphone access is blocked for this site. Click the icon left of the address bar, allow the microphone, and reload.';
  }
  if (kind === 'busy') return 'Another app is using the microphone, often a call or a voice recorder. Close it and try again.';
  if (kind === 'none') return 'No microphone was found on this device.';
  if (kind === 'insecure') return 'The microphone only works on the secure (https) address of this app.';
  if (kind === 'nomedia') { const a = inAppBrowser(); return a ? openElsewhereHtml(a) : 'This browser can’t use the microphone. Open the app in Chrome (Android) or Safari (iPhone).'; }
  return 'The microphone couldn’t start.';
}
function micError(e) {
  const kind = e.name === 'NotAllowedError' || e.name === 'SecurityError' || e.name === 'PermissionDeniedError' ? 'denied'
    : e.name === 'NotReadableError' || e.name === 'AbortError' ? 'busy' : e.name === 'NotFoundError' ? 'none'
    : e.name === 'Insecure' ? 'insecure' : e.name === 'NoMedia' ? 'nomedia' : 'other';
  const app = inAppBrowser();
  const short = { denied: 'The microphone is blocked for this site.', busy: 'Another app is using the microphone.', none: 'No microphone found.',
    insecure: 'The microphone needs the secure (https) address.', nomedia: 'This browser can’t use the microphone.', other: 'The microphone couldn’t start (' + esc(e.name || e.message) + ').' }[kind];
  setStatus(short + ' <button class="linkbtn" data-help>How to fix</button>', true);
  if (app) showEnvBanner(true);
}
document.addEventListener('click', e => { if (e.target.closest('[data-help]')) { diagnostics(); openSheet('help'); } });
function showEnvBanner(force) {
  const app = inAppBrowser(), b = $('envBanner');
  if (app && (force || !load('envDismissed', false))) { b.innerHTML = openElsewhereHtml(app); b.hidden = false; return; }
  b.hidden = true;
}
document.addEventListener('click', e => {
  const c = e.target.closest('[data-copy]'); if (!c) return;
  copyText(SHARE_URL).then(ok => toast(ok ? 'Link copied. Paste it into ' + (IOS ? 'Safari' : 'Chrome') + '.' : SHARE_URL));
});
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch (e) {}
  try { const a = document.createElement('textarea'); a.value = t; document.body.appendChild(a); a.select(); const ok = document.execCommand('copy'); a.remove(); return ok; } catch (e) { return false; }
}
async function micPermission() {
  try { const p = await navigator.permissions.query({ name: 'microphone' }); return p.state; } catch (e) { return 'unknown'; }
}
async function diagnostics() {
  const perm = await micPermission(), app = inAppBrowser();
  const lines = [
    'Version: ' + APP_VERSION,
    'Device: ' + (IOS ? 'iPhone/iPad' : ANDROID ? 'Android' : 'computer'),
    'Opened in: ' + (app ? app + ' (in-app browser)' : STANDALONE ? 'home-screen app' : 'browser'),
    'Secure address: ' + (window.isSecureContext ? 'yes' : 'no'),
    'Microphone API: ' + (navigator.mediaDevices && navigator.mediaDevices.getUserMedia ? 'yes' : 'no'),
    'Microphone permission: ' + perm,
    'Audio worklet: ' + (window.AudioWorkletNode ? 'yes' : 'no (fallback used)'),
    'Keep screen on: ' + ('wakeLock' in navigator ? 'supported' : 'not supported'),
    'Voice settings: sensitivity ' + S.sens + ', pause ' + S.gap + ' ms, pace ' + V.rate + ' ms/letter',
    'Browser: ' + UA
  ];
  let verdict;
  if (app) verdict = openElsewhereHtml(app);
  else if (!window.isSecureContext || !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) verdict = micHelp(window.isSecureContext ? 'nomedia' : 'insecure');
  else if (perm === 'denied') verdict = micHelp('denied');
  else verdict = 'Everything needed for voice counting is available' + (perm === 'granted' ? ' and the microphone is allowed.' : '. You’ll be asked to allow the microphone the first time you tap it.');
  $('helpBody').innerHTML = '<div class="banner ' + (app || perm === 'denied' ? '' : 'info') + '">' + '<div>' + verdict + '</div></div>' +
    '<h2>Try the microphone</h2><p class="muted">Speak and watch the bar move. If it doesn’t move, the phone isn’t letting this page hear you.</p>' +
    '<div class="meterbox"><i id="diagLv"></i></div><button class="btn" id="diagMic">Test the microphone</button>' +
    '<h2>Details</h2><p class="muted">If you need help, copy this and send it to whoever shared the app with you.</p><pre class="diag" id="diagTxt">' + esc(lines.join('\n')) + '</pre>' +
    '<div class="acts" style="display:flex;gap:8px;margin-top:10px"><button class="btn" id="diagCopy">Copy details</button></div>';
  $('diagCopy').onclick = () => copyText(lines.join('\n')).then(ok => toast(ok ? 'Copied' : 'Select the text and copy it'));
  $('diagMic').onclick = testMic;
}
let testing = false;
async function testMic() {
  if (testing || listening) { if (listening) toast('Stop voice counting first'); return; }
  testing = true; $('diagMic').disabled = true; $('diagMic').textContent = 'Listening for 6 seconds…';
  try {
    await openMic();
    let floor = null, best = 0;
    onFrame = db => { floor = floor == null ? db : Math.min(floor + 0.05, db < floor ? db : floor); const x = Math.max(0, Math.min(1, (db - floor) / 30)); best = Math.max(best, x); const el = $('diagLv'); if (el) el.style.width = (x * 100).toFixed(0) + '%'; };
    await new Promise(r => setTimeout(r, 6000));
    closeMic();
    $('diagMic').textContent = best > 0.3 ? 'It hears you. Test again' : 'Barely heard anything. Test again';
  } catch (e) { closeMic(); $('diagMic').textContent = 'Couldn’t open the microphone'; micError(e); }
  testing = false; $('diagMic').disabled = false;
}

// ---------- tune to my voice ----------
let tuning = null;
function openTune() {
  if (listening) stop();
  tuning = null; $('tuneDots').innerHTML = ''; $('tuneThr').hidden = true; $('tuneLv').style.width = '0';
  $('tuneMsg').textContent = 'Find a usual spot, then tap Begin';
  $('tuneSub').textContent = 'First stay quiet for 3 seconds. Then recite ' + nameOf(E0().k) + ' five times at your normal pace.';
  $('tuneGo').textContent = 'Begin'; $('tuneGo').disabled = false;
  openSheet('tune');
}
async function runTune() {
  $('tuneGo').disabled = true;
  try { await openMic(); } catch (e) { closeSheet(); micError(e); return; }
  const k = E0().k, quiet = [], runs = [], gaps = [], peaks = [];
  let phase = 'quiet', t0 = performance.now(), floor = 0, sens = 12, on = false, runStart = 0, lastLoud = 0, voiced = 0, endT = 0;
  $('tuneMsg').textContent = 'Stay quiet…'; $('tuneSub').textContent = '3 seconds';
  $('tuneDots').innerHTML = '<i></i><i></i><i></i><i></i><i></i>';
  tuning = true;
  const finish = ok => {
    onFrame = null; closeMic(); tuning = null; $('tuneGo').disabled = false; $('tuneGo').textContent = ok ? 'Done' : 'Try again';
    $('tuneGo').onclick = ok ? closeSheet : runTune;
  };
  onFrame = (db, ms) => {
    const t = performance.now();
    $('tuneLv').style.width = Math.max(0, Math.min(100, (db + 90) * 1.4)).toFixed(0) + '%';
    if (phase === 'quiet') {
      quiet.push(db);
      $('tuneSub').textContent = Math.max(1, Math.ceil(3 - (t - t0) / 1000)) + ' seconds';
      if (t - t0 > 3000) {
        const s = quiet.slice(5).sort((a, b) => a - b);
        floor = s[Math.floor(s.length * 0.5)]; const noisy = s[Math.floor(s.length * 0.95)];
        sens = Math.max(8, noisy - floor + 6);
        phase = 'speak'; t0 = t;
        $('tuneThr').hidden = false; $('tuneThr').style.left = Math.max(0, Math.min(100, (floor + sens + 90) * 1.4)) + '%';
        $('tuneMsg').textContent = 'Now recite ' + nameOf(k) + ' five times'; $('tuneSub').textContent = 'At your normal pace, with a breath between each.';
      }
      return;
    }
    const loud = db > floor + (on ? sens * 0.6 : sens);
    if (loud) { if (!on) { on = true; runStart = t; if (endT) gaps.push(t - endT); peaks.push(db); } voiced += ms; lastLoud = t; peaks[peaks.length - 1] = Math.max(peaks[peaks.length - 1], db); }
    else if (on && t - lastLoud > 220) {
      on = false; endT = lastLoud;
      if (voiced > 150) { runs.push(voiced); const d = $('tuneDots').children[Math.min(4, runs.length - 1)]; d && d.classList.add('on'); }
      else { gaps.pop(); peaks.pop(); }
      voiced = 0;
    }
    if (runs.length >= 5 || t - t0 > 25000) {
      phase = 'done';
      if (runs.length < 3) {
        $('tuneMsg').textContent = 'I couldn’t hear you clearly';
        $('tuneSub').textContent = runs.length ? 'Only ' + runs.length + ' heard. Hold the phone closer or speak a little louder.' : 'Check the microphone isn’t covered, or use Check my setup.';
        finish(false); return;
      }
      const med = a => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
      const T = med(runs), g = gaps.length ? med(gaps) : 400, pk = med(peaks);
      // threshold halfway between the room and your voice; pause about half your usual breath
      S.sens = Math.round(Math.max(0, Math.min(100, (22 - Math.max(5, Math.min(22, (pk - floor) * 0.45))) / 0.17)));
      S.gap = Math.round(Math.max(140, Math.min(600, g * 0.55)) / 10) * 10;
      const L = letters(P[k].ar); if (L) V.rate = Math.round(Math.max(30, Math.min(140, T / L)));
      V.T[k] = Math.round(T); saveVoice(); saveSettings(); fillSettings();
      $('tuneMsg').textContent = 'Tuned to your voice';
      $('tuneSub').textContent = 'About ' + (T / 1000).toFixed(1) + ' s per recitation, with ' + (g / 1000).toFixed(1) + ' s breaths. Other adhkar are timed from your pace.';
      finish(true);
    }
  };
}
$('tuneGo').onclick = runTune;
$('tuneBtn').onclick = () => { closeSheet(); openTune(); };

// ---------- pronunciation ----------
let saying = false;
const sayAudio = new Audio(); sayAudio.preload = 'none';
const pad3 = n => String(n).padStart(3, '0');
function audioUrls(p) {
  if (p.q && p.q.length) {
    const out = [];
    for (const [s, a] of p.q) out.push('https://everyayah.com/data/Alafasy_128kbps/' + pad3(s) + pad3(a) + '.mp3');
    return out;
  }
  if (p.au) return [p.au.startsWith('rn/') ? AUDIO_CDN + p.au.slice(3) + '.mp3' : ROOT + p.au];
  return null;
}
function sayIcon() { $('say').classList.toggle('on', saying); $('say').querySelector('span').textContent = saying ? 'Stop' : 'Listen'; }
function sayStop() {
  if (!saying) return;
  saying = false; muteUntil = performance.now() + 500; sayIcon();
  sayAudio.onended = sayAudio.onerror = null; try { sayAudio.pause(); } catch (e) {}
  if (det) det.acc = 0;
}
function playList(urls, i) {
  if (!saying) return;
  if (i >= urls.length) return sayStop();
  sayAudio.onended = () => playList(urls, i + 1);
  sayAudio.onerror = () => { if (!saying) return; toast('Couldn’t load the recording. It needs an internet connection.'); sayStop(); };
  sayAudio.src = urls[i];
  sayAudio.play().catch(() => sayAudio.onerror && sayAudio.onerror());
}
$('say').onclick = () => { if (saying) return sayStop(); const u = audioUrls(P[E0().k]); if (!u) return; saying = true; sayIcon(); playList(u, 0); };

// ---------- drawer ----------
const wide = matchMedia('(min-width:980px)');
const openCats = new Set();
const drawerOpen = () => $('drawer').classList.contains('open');
function renderList() {
  const el = $('list'); el.innerHTML = '';
  let group = null;
  for (const c of ALLCATS) {
    const list = entriesOf(c.id);
    if (c.id === 'mine' && !list.length) continue;
    if (c.group !== group) { group = c.group; const g = document.createElement('div'); g.className = 'group'; g.textContent = group; el.appendChild(g); }
    const done = list.filter(isDone).length, open = openCats.has(c.id);
    const sec = document.createElement('section'); sec.className = 'cat';
    const h = document.createElement('button'); h.className = 'cathead'; h.setAttribute('aria-expanded', open);
    h.innerHTML = '<span class="arw" aria-hidden="true">›</span><span></span><span class="n"></span>';
    h.children[1].textContent = c.name;
    h.children[2].textContent = done ? (done === list.length ? '✓ ' : '') + done + '/' + list.length : list.length;
    h.onclick = () => { open ? openCats.delete(c.id) : openCats.add(c.id); renderList(); };
    sec.appendChild(h);
    if (open) {
      if (c.note) { const n = document.createElement('div'); n.className = 'catnote'; n.textContent = c.note; sec.appendChild(n); }
      const ul = document.createElement('ul'); ul.className = 'items';
      for (const e of list) {
        const li = document.createElement('li'), b = document.createElement('button'), fin = isDone(e);
        b.className = 'item' + (fin ? ' fin' : ''); if (e === E0()) b.setAttribute('aria-current', 'true');
        b.innerHTML = '<span></span><span class="p"></span>'; b.children[0].textContent = nameOf(e.k);
        b.children[1].textContent = fin ? '✓' : count(e) ? count(e) + '/' + target(e) : '×' + target(e);
        b.onclick = () => { select(E.indexOf(e)); closeDrawer(); };
        li.appendChild(b); ul.appendChild(li);
      }
      sec.appendChild(ul);
    }
    el.appendChild(sec);
  }
}
function openDrawer() {
  openCats.add(E0().cat); renderList();
  $('drawer').classList.add('open'); $('scrim').hidden = false; $('menuBtn').setAttribute('aria-expanded', 'true');
  const c = $('list').querySelector('[aria-current]'); c && c.scrollIntoView({ block: 'center' }); c && c.focus({ preventScroll: true });
}
function closeDrawer() {
  if (wide.matches || !drawerOpen()) return;
  $('drawer').classList.remove('open'); $('scrim').hidden = true; $('menuBtn').setAttribute('aria-expanded', 'false');
}
$('menuBtn').onclick = openDrawer; $('where').onclick = openDrawer; $('closeDrawer').onclick = closeDrawer; $('scrim').onclick = closeDrawer;
let sx = null;
$('drawer').addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, { passive: true });
$('drawer').addEventListener('touchend', e => { if (sx != null && e.changedTouches[0].clientX - sx < -60) closeDrawer(); sx = null; }, { passive: true });
// swipe the text left/right to move through the list
let tx = null, ty = null;
$('text').addEventListener('touchstart', e => { tx = e.touches[0].clientX; ty = e.touches[0].clientY; }, { passive: true });
$('text').addEventListener('touchend', e => {
  if (tx == null) return; const dx = e.changedTouches[0].clientX - tx, dy = e.changedTouches[0].clientY - ty; tx = null;
  if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
}, { passive: true });

// ---------- sheets ----------
let openId = null, returnFocus = null;
function openSheet(id) {
  closeDrawer(); if (openId) $(openId).hidden = true;
  returnFocus = returnFocus || document.activeElement; openId = id; $(id).hidden = false; $(id).scrollTop = 0;
  document.body.style.overflow = 'hidden';
  const f = $(id).querySelector('[data-close]'); f && f.focus({ preventScroll: true });
}
function closeSheet() {
  if (!openId) return;
  if (openId === 'tune' && tuning) { onFrame = null; closeMic(); tuning = null; }
  if (openId === 'help' && testing) { closeMic(); testing = false; }
  $(openId).hidden = true; openId = null; document.body.style.overflow = '';
  if (returnFocus && returnFocus.focus) returnFocus.focus({ preventScroll: true }); returnFocus = null;
  render();
}
document.querySelectorAll('[data-close]').forEach(b => b.onclick = closeSheet);
addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (openId) closeSheet(); else closeDrawer(); return; }
  if (openId || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  if ((e.key === ' ' || e.key === 'Enter') && document.activeElement === document.body) { e.preventDefault(); add(1, 'tap'); }
  else if (e.key === 'ArrowRight') step(1); else if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'Backspace') add(-1, 'tap');
});

// ---------- controls ----------
$('ring').onclick = () => add(1, 'tap');
$('undo').onclick = () => { add(-1, 'tap'); if (lastAdd && lastAdd.how === 'voice') setStatus('Undone. If noise keeps counting, lower the sensitivity in Settings.'); lastAdd = null; };
let resetArm = 0;
$('reset').onclick = () => {
  const e = E0(); if (!count(e)) return;
  if (Date.now() - resetArm > 2500) { resetArm = Date.now(); toast('Tap reset again to clear ' + count(e)); return; }
  resetArm = 0; st.c[e.key] = 0; saveState(); drawCount(); setStatus('Reset.');
};
$('prev').onclick = () => step(-1);
$('next').onclick = () => step(1);
$('infoBtn').onclick = () => {
  const p = P[E0().k];
  $('infoTitle').textContent = p.name;
  $('infoBody').innerHTML = (p.why ? '<p><b>' + esc(p.why) + '</b></p>' : '') + (p.ref ? '<h2>Source</h2><p>' + esc(p.ref) + '</p>' : '') +
    (p.src ? '<p class="muted">From ' + esc(p.src) + '.</p>' : '') + (p.q ? '<p class="muted">The recording plays the full verse' + (p.q.length > 1 ? 's' : '') + '.</p>' : '');
  openSheet('info');
};
$('histBtn').onclick = () => { renderHist(); openSheet('hist'); };
$('dHist').onclick = () => { renderHist(); openSheet('hist'); };
$('setBtn').onclick = () => { fillSettings(); openSheet('settings'); };
$('diagBtn').onclick = () => { diagnostics(); openSheet('help'); };

// ---------- settings ----------
function fillSettings() {
  for (const id of ['split', 'vib', 'click', 'wake', 'showTr', 'showEn', 'auto']) $(id).checked = !!S[id];
  $('sens').value = S.sens; $('gap').value = S.gap;
  $('gapTxt').textContent = 'Counts after ' + (S.gap / 1000).toFixed(2) + ' s of quiet. Raise it if one long phrase counts as two.';
  $('target').value = target(E0()); $('targetTxt').textContent = nameOf(E0().k) + ' · usually ' + E0().n;
  $('vibNote').hidden = !IOS; $('ver').textContent = APP_VERSION;
}
for (const id of ['split', 'vib', 'click', 'wake', 'showTr', 'showEn', 'auto']) $(id).onchange = () => { S[id] = $(id).checked; saveSettings(); if (id === 'wake') keepAwake(listening); };
$('sens').oninput = () => { S.sens = +$('sens').value; saveSettings(); if (det) det.o.sens = sensDb(); };
$('gap').oninput = () => { S.gap = +$('gap').value; saveSettings(); fillSettings(); if (det) det.o.gap = S.gap; };
$('split').addEventListener('change', () => { if (det) det.o.split = S.split; });
$('target').onchange = () => { const e = E0(), v = Math.max(1, Math.min(10000, parseInt($('target').value) || e.n)); if (v === e.n) delete st.n[e.key]; else st.n[e.key] = v; saveState(); fillSettings(); };
$('resetDay').onclick = () => { if (Date.now() - resetArm > 2500) { resetArm = Date.now(); toast('Tap again to reset all of today’s counts'); return; } resetArm = 0; st.c = {}; saveState(); render(); toast('Today’s counts reset'); };

// ---------- custom adhkar ----------
function renderCustomList() {
  const box = $('customList');
  box.innerHTML = custom.length ? '<h2>Yours</h2><div class="card">' + custom.map(c => '<div class="row"><div class="grow"><b>' + esc(c.name) + '</b><small>×' + c.n + '</small></div><button class="btn sm" data-del="' + c.id + '">Delete</button></div>').join('') + '</div>' : '';
  box.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Tap to confirm'; return; }
    const id = +b.dataset.del, i = custom.findIndex(c => c.id === id); if (i < 0) return;
    custom.splice(i, 1); save('custom', custom); delete P['c' + id];
    catOf('mine').items = custom.map(c => ['c' + c.id, c.n]);
    const key = E0().key; buildEntries(); cur = Math.max(0, E.findIndex(e => e.key === key));
    renderCustomList(); toast('Deleted');
  });
}
$('addCustom').onclick = () => { renderCustomList(); openSheet('custom'); setTimeout(() => $('cName').focus(), 50); };
$('customForm').onsubmit = ev => {
  ev.preventDefault();
  const name = $('cName').value.trim(); if (!name) return;
  const c = { id: Date.now(), name, ar: $('cAr').value.trim(), en: $('cEn').value.trim(), n: Math.max(1, Math.min(10000, parseInt($('cN').value) || 33)) };
  custom.push(c); save('custom', custom); P['c' + c.id] = customItem(c);
  catOf('mine').items = custom.map(x => ['c' + x.id, x.n]); buildEntries();
  $('customForm').reset(); $('cN').value = 33;
  closeSheet(); select(E.findIndex(e => e.k === 'c' + c.id)); toast('Saved to My adhkar');
};

// ---------- history ----------
function streaks(ok) {
  let best = 0, run = 0, prev = null;
  for (const k of Object.keys(history).sort()) { if (!ok(history[k])) continue; run = prev && addDays(prev, 1) === k ? run + 1 : 1; prev = k; best = Math.max(best, run); }
  let c = 0, k = ok(history[today] || {}) ? today : addDays(today, -1);
  while (history[k] && ok(history[k])) { c++; k = addDays(k, -1); }
  return { cur: c, best, todayDone: ok(history[today] || {}) };
}
let histMonth = null, histSel = null;
const fmt = n => n.toLocaleString();
const level = t => !t ? 0 : t < 34 ? 1 : t < 100 ? 2 : t < 300 ? 3 : 4;
function renderHist() {
  const all = streaks(h => h.t > 0);
  $('sCur').textContent = all.cur;
  $('sCurNote').textContent = all.todayDone ? 'Today counted. Keep it going.' : all.cur ? 'Some dhikr today keeps it going.' : 'Start today.';
  $('sBest').textContent = all.best;
  let wk = 0; for (let i = 0; i < 7; i++) wk += (history[addDays(today, -i)] || {}).t || 0;
  $('sWeek').textContent = fmt(wk);
  $('sAll').textContent = fmt(Object.values(history).reduce((a, h) => a + (h.t || 0), 0));
  $('rout').innerHTML = '';
  for (const id of ['am', 'pm', 'salah', 'sleep']) {
    const s = streaks(h => (h.d || []).includes(id)), c = catOf(id);
    const row = document.createElement('div'); row.className = 'row';
    row.innerHTML = '<div class="grow"></div><span class="muted"></span>';
    row.children[0].textContent = (s.todayDone ? '✓ ' : '') + c.name;
    row.children[1].textContent = s.cur + (s.cur === 1 ? ' day' : ' days') + (s.best > s.cur ? ' · best ' + s.best : '');
    $('rout').appendChild(row);
  }
  if (!histMonth) histMonth = today.slice(0, 7);
  if (!histSel) histSel = today;
  const [y, m] = histMonth.split('-').map(Number), first = new Date(y, m - 1, 1), days = new Date(y, m, 0).getDate();
  $('mName').textContent = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  $('mNext').disabled = histMonth >= today.slice(0, 7);
  const cal = $('cal'); cal.innerHTML = '';
  for (let i = 0; i < 7; i++) { const d = document.createElement('div'); d.className = 'wd'; d.setAttribute('aria-hidden', 'true'); d.textContent = new Date(2023, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'narrow' }); cal.appendChild(d); }
  for (let i = 0; i < first.getDay(); i++) cal.appendChild(document.createElement('div'));
  for (let d = 1; d <= days; d++) {
    const k = dk(new Date(y, m - 1, d)), h = history[k], t = h ? h.t : 0, b = document.createElement('button');
    b.className = 'day l' + level(t) + (k === today ? ' today' : '') + (k === histSel ? ' sel' : ''); b.textContent = d; b.disabled = k > today;
    b.setAttribute('aria-label', new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) + ': ' + (t ? fmt(t) + ' dhikr' : 'none'));
    b.onclick = () => { histSel = k; renderHist(); };
    cal.appendChild(b);
  }
  const h = history[histSel], dd = $('dayDetail'), [sy, sm, sd] = histSel.split('-').map(Number);
  let html = '<h2>' + esc(new Date(sy, sm - 1, sd).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })) + (h ? ' · ' + fmt(h.t) : '') + '</h2>';
  if (!h) html += '<p class="muted">' + (histSel === today ? 'Nothing yet today.' : 'No dhikr recorded this day.') + '</p>';
  else {
    if (h.d && h.d.length) html += '<p>Completed: ' + h.d.map(id => esc((catOf(id) || { name: id }).name)).join(', ') + '</p>';
    html += '<ul class="daylist">' + Object.entries(h.c || {}).sort((a, b) => b[1] - a[1]).map(([n, v]) => '<li><span>' + esc(n) + '</span><span>' + fmt(v) + '</span></li>').join('') + '</ul>';
  }
  dd.innerHTML = html;
}
$('mPrev').onclick = () => { histMonth = addDays(histMonth + '-01', -1).slice(0, 7); renderHist(); };
$('mNext').onclick = () => { const [y, m] = histMonth.split('-').map(Number); histMonth = dk(new Date(y, m, 1)).slice(0, 7); renderHist(); };

// ---------- time of day ----------
let hijri = '';
try {
  const parts = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', { day: 'numeric', month: 'long' }).formatToParts(new Date());
  const part = t => (parts.find(p => p.type === t) || {}).value;
  if (part('day') && part('month')) hijri = part('day') + ' ' + part('month');
} catch (e) {}
function suggest() {
  const h = new Date().getHours(), dow = new Date().getDay();
  const id = h >= 4 && h < 11 ? 'am' : h >= 15 && h < 20 ? 'pm' : (h >= 21 || h < 2) ? 'sleep' : dow === 5 ? 'friday' : null;
  const b = $('suggest');
  if (!id || E0().cat === id || entriesOf(id).every(isDone)) { b.hidden = true; return; }
  const c = catOf(id);
  b.querySelector('span').textContent = (id === 'am' ? 'It’s morning: ' : id === 'pm' ? 'It’s evening: ' : id === 'sleep' ? 'Before bed: ' : 'Friday: ') + c.name + ' adhkar';
  b.onclick = () => { const e = entriesOf(id).find(x => !isDone(x)) || entriesOf(id)[0]; select(E.indexOf(e)); b.hidden = true; };
  b.hidden = false;
}

// ---------- share, install, updates ----------
async function share() {
  const text = 'Hands-free Tasbeeh: it listens as you recite and counts for you. Open the link in Chrome (Android) or Safari (iPhone), then add it to your home screen.';
  try { if (navigator.share) { await navigator.share({ title: 'Hands-free Tasbeeh', text, url: SHARE_URL }); return; } } catch (e) { if (e.name === 'AbortError') return; }
  const ok = await copyText(text + ' ' + SHARE_URL); toast(ok ? 'Link and instructions copied' : SHARE_URL);
}
$('shareBtn').onclick = share; $('dShare').onclick = share;
let installEvt = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('installRow').hidden = false; $('installTxt').textContent = 'Opens full screen and works offline.'; });
addEventListener('appinstalled', () => { $('installRow').hidden = true; toast('Installed'); });
if (IOS && !STANDALONE && !inAppBrowser()) { $('installRow').hidden = false; $('installBtn').textContent = 'How'; $('installTxt').textContent = 'Tap the Share button in Safari, then “Add to Home Screen”.'; }
$('installBtn').onclick = async () => {
  if (installEvt) { installEvt.prompt(); try { await installEvt.userChoice; } catch (e) {} installEvt = null; $('installRow').hidden = true; }
  else toast('In Safari: Share → Add to Home Screen');
};
if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {}));
async function checkUpdate() {
  try {
    const js = await (await fetch('app.js?check=' + Date.now(), { cache: 'no-store' })).text();
    const v = (js.match(/APP_VERSION = '([^']+)'/) || [])[1];
    if (v && v !== APP_VERSION) $('update').hidden = false;
    navigator.serviceWorker && navigator.serviceWorker.getRegistration().then(r => r && r.update()).catch(() => {});
  } catch (e) {}
}
$('update').onclick = () => location.reload();

// ---------- status & toast ----------
function setStatus(html, err) { const s = $('status'); s.innerHTML = html; s.classList.toggle('err', !!err); }
let toastT = 0;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2600); }

// ---------- first run ----------
function welcome() {
  const g = $('welBeads'); let h = '';
  for (let i = 0; i < 11; i++) { const a = -Math.PI / 2 + (i + 1) * 2 * Math.PI / 12; h += '<circle cx="' + (60 + 46 * Math.cos(a)).toFixed(1) + '" cy="' + (60 + 46 * Math.sin(a)).toFixed(1) + '" r="7" fill="' + (i < 7 ? 'var(--bead)' : 'var(--surface)') + '" stroke="var(--bead)" stroke-width="1.5"/>'; }
  g.innerHTML = '<circle cx="60" cy="60" r="46" fill="none" stroke="var(--line)"/>' + h + '<ellipse cx="60" cy="14" rx="5" ry="9" fill="var(--bead-soft)" stroke="var(--bead)" stroke-width="1.5"/>';
  const app = inAppBrowser();
  $('welEnv').innerHTML = app ? '<div class="banner">' + '<div>' + openElsewhereHtml(app) + '</div></div>' : '';
  $('welMic').onclick = async () => { save('welcomed', true); closeSheet(); await start(); };
  $('welSkip').onclick = () => { save('welcomed', true); closeSheet(); };
  openSheet('welcome');
}

// ---------- start ----------
// test hook: feed the detector synthetic loudness frames (used by the developer, harmless otherwise)
window.__tasbeeh = { Rhythm, expectedMs, P, E: () => E, go: key => select(E.findIndex(e => e.key === key)) };
document.documentElement.dataset.ready = '1';
render(); suggest(); showEnvBanner();
if (!load('welcomed', false)) welcome();
addEventListener('load', checkUpdate);
micPermission().then(p => { if (p === 'denied') setStatus('The microphone is blocked for this site. <button class="linkbtn" data-help>How to fix</button>', true); });
