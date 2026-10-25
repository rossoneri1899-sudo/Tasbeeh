'use strict';
// Hands-free Tasbeeh. Counts recitations by their rhythm: each phrase is a burst of voice followed by a pause.
// Nothing leaves the phone: the microphone is only used to measure loudness, 50 times a second.

// Bump on every deploy. The page compares it with the live copy when it opens or comes back to the foreground,
// because phones resume home-screen apps from memory instead of reloading them.
const APP_VERSION = '14';
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

const DEFAULTS = { v: 2, sens: 50, gap: 350, split: false, whisper: false, vib: true, click: false, wake: true, showTr: true, showEn: true, auto: true };
const S = Object.assign({}, DEFAULTS, load('settings', {}));
// b1 split slow recitations into several counts and was too eager: reset the voice settings once
if (S.v !== 2) Object.assign(S, { v: 2, sens: DEFAULTS.sens, gap: DEFAULTS.gap, split: false });
const saveSettings = () => save('settings', S);
// voice: per dhikr, T = usual length of one recitation in ms (N = how many it has seen), skip = said no to teaching
const V = Object.assign({ T: {}, N: {}, skip: {} }, load('voice', {}));
if (V.rate) { V.T = {}; delete V.rate; } // lengths learned by b1 were distorted by its splitting
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
const NOLIMIT = -1; // stored target meaning "keep counting": the beads go round in 33s
const target = e => st.n[e.key] === NOLIMIT ? Infinity : st.n[e.key] || e.n;
const isDone = e => count(e) >= target(e);
// Whispered recordings are kept apart from voiced ones (a whisper sounds different): key 'sub~w' next to 'sub'
const base = k => k.replace(/~w$/, '');
const sk = k => S.whisper ? k + '~w' : k;
const nameOf = k => P[base(k)] ? P[base(k)].name : k === '_voice' ? 'Your voice' : k;

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
  if (listening) arm();
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
  const e = E0(), c = count(e), t = target(e), endless = !isFinite(t), n = endless ? 33 : t;
  $('num').textContent = c;
  const rounds = Math.floor(c / n), nth = r => r + (r === 2 ? 'nd' : r === 3 ? 'rd' : 'th');
  $('of').textContent = endless ? (c >= 33 ? 'no limit · ' + nth(rounds + 1) + ' 33' : 'no limit')
    : c >= n && n > 1 ? (c === n ? 'done' : 'of ' + n + ' · ' + nth(rounds + 1) + ' round') : n === 1 ? (c ? 'done' : 'once') : 'of ' + n;
  $('ring').classList.toggle('done', !endless && c >= n);
  $('ring').setAttribute('aria-label', 'Count one. ' + c + (endless ? '' : ' of ' + n));
  $('targetBtn').querySelector('span').textContent = endless ? 'No limit' : 'Target ' + n;
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

// ---------- voice counting ----------
// Sensitivity slider 0..100: how far above the room a sound must be (24..10 dB) and how loose a match may be.
const sensDb = () => 24 - S.sens * 0.14;
const matchMul = () => 0.85 + S.sens * 0.004;
// dhikr key -> {pos: [{id, f, st}], neg: [...]}; f = MFCC template, st = voice stats for the profile.
// Key '_voice' holds "Train my voice" recordings: used for the profile only, never matched.
const samples = {};
let calCache = {}, profCache;
const sampleSet = k => samples[k] || (samples[k] = { pos: [], neg: [] });
const taught = k => !!(samples[k] && samples[k].pos.length >= 3);
const LEARN_N = 5; // recitations kept while learning a dhikr by itself
function addLocal(k, x, neg) {
  const r = { id: null, f: Voice.template(x), st: neg ? null : Voice.voiceStats(Voice.frames(x)) };
  sampleSet(k)[neg ? 'neg' : 'pos'].push(r); calCache = {}; profCache = undefined; return r;
}
// what your voice sounds like, from every recording of you (any dhikr); null until there are 6
function voiceProfile() {
  if (profCache === undefined) profCache = Voice.profile(Object.values(samples).flatMap(s => s.pos.map(r => r.st)));
  return profCache;
}
const profileCount = () => Object.values(samples).reduce((a, s) => a + s.pos.filter(r => r.st).length, 0);
async function saveSample(k, x, neg) {
  const r = addLocal(k, x, neg);
  try { r.id = await Voice.store.add({ k, neg: !!neg, a: Voice.toInt16(x), at: Date.now() }); } catch (e) {}
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
}
async function dropSamples(k) {
  const s = sampleSet(k);
  for (const r of s.pos.concat(s.neg)) { try { if (r.id != null) await Voice.store.del(r.id); } catch (e) {} }
  s.pos = []; s.neg = []; calCache = {}; profCache = undefined; delete pend[k];
}
// Learning as you recite: recitations counted by rhythm are kept; any you Undo are dropped. Once there are
// LEARN_N that agree with each other they become this dhikr's recordings and matching takes over.
const pend = {}; // dhikr key -> [{x: audio, at}]
async function learnFromPending(k) {
  const list = pend[k] || []; if (list.length < LEARN_N) return;
  const keep = Voice.consistent(list.map(c => Voice.template(c.x)));
  if (keep.length < 3) { list.shift(); return; } // too different from each other: wait for more
  for (const i of keep) await saveSample(k, list[i].x, false);
  delete pend[k];
  if (listening && sk(E0().k) === k) arm();
  toast('Learned how you say ' + nameOf(k) + '. Now only sounds like yours count.');
}
async function loadSamples() {
  try {
    for (const r of await Voice.store.all()) { const x = addLocal(r.k, Voice.fromInt16(r.a), r.neg); x.id = r.id; }
    if (!load('importedOld', false)) { // recordings made with "Train it on my voice" in the old app
      const byName = {}; for (const [k, p] of Object.entries(P)) if (!p.custom && !byName[p.name]) byName[p.name] = k;
      let n = 0;
      for (const r of await Voice.oldSamples()) {
        const neg = /#not$/.test(r.t || ''), k = byName[(r.t || '').replace(/#not$/, '')];
        if (!k || !r.a) continue;
        await saveSample(k, Voice.fromInt16(r.a), neg); n++;
      }
      save('importedOld', true);
      if (n) toast('Brought over ' + n + ' voice recordings from the old app');
    }
  } catch (e) {}
  render();
}
// Threshold for one dhikr. Other adhkar's recordings count as "not this", except phrases inside each other
// (SubhanAllah / SubhanAllahi wa bihamdihi), which would otherwise reject each other.
function calFor(k) {
  if (k in calCache) return calCache[k];
  const s = samples[k], p = P[base(k)], w = k.endsWith('~w'); if (!p || !s || s.pos.length < 3) return (calCache[k] = null);
  const key = letters(p.ar) ? p.ar.replace(/[^ء-ي]/g, '') : '';
  const neg = s.neg.map(r => r.f);
  for (const [k2, s2] of Object.entries(samples)) {
    if (k2 === k || !P[base(k2)] || k2.endsWith('~w') !== w) continue; // compare whispers with whispers
    const key2 = (P[base(k2)].ar || '').replace(/[^ء-ي]/g, '');
    if (key && key2 && (key.includes(key2) || key2.includes(key))) continue;
    for (const r of s2.pos.slice(-8)) neg.push(r.f);
  }
  return (calCache[k] = Voice.calibrate(s.pos.map(r => r.f), neg));
}
function learnLen(k, ms) { V.T[k] = Math.round(V.T[k] ? V.T[k] * 0.8 + ms * 0.2 : ms); V.N[k] = (V.N[k] || 0) + 1; saveVoice(); }

// ---------- microphone ----------
let ctx = null, stream = null, node = null, front = null, listening = false, wake = null, muteUntil = 0, onFrame = null;
let seg = null, match = null, segHit = false, lastHit = null, lastMiss = null, lastWhisper = null;
// the worklet only hands raw audio to the page; all analysis happens in voice.js
const WORKLET = `class A extends AudioWorkletProcessor{constructor(){super();this.b=new Float32Array(2048);this.n=0}
process(i){const c=i[0]&&i[0][0];if(c){for(let k=0;k<c.length;k++){this.b[this.n++]=c[k];if(this.n===2048){this.port.postMessage(this.b.slice(0));this.n=0}}}return true}}
registerProcessor('tap',A)`;
async function openMic() {
  if (!window.isSecureContext) throw Object.assign(new Error('insecure'), { name: 'Insecure' });
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error('nomedia'), { name: 'NoMedia' });
  try {
    // phones' noise suppression treats a whisper as noise and removes it
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: !S.whisper, autoGainControl: false, channelCount: 1 } });
  } catch (e) {
    if (e.name !== 'OverconstrainedError' && e.name !== 'TypeError') throw e;
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') await ctx.resume();
  const src = ctx.createMediaStreamSource(stream);
  // keep the voice band, drop rumble and hiss
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 100;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3800;
  src.connect(hp); hp.connect(lp);
  const sink = ctx.createGain(); sink.gain.value = 0; sink.connect(ctx.destination);
  front = new Voice.Front();
  const rs = new Voice.Resampler(ctx.sampleRate), f = front;
  const chunk = x => { const fs = f.push(rs.push(x)); if (onFrame) for (const fr of fs) onFrame(fr); };
  try {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    node = new AudioWorkletNode(ctx, 'tap');
    node.port.onmessage = e => chunk(e.data);
  } catch (e) { // older browsers
    node = ctx.createScriptProcessor(2048, 1, 1);
    node.onaudioprocess = ev => chunk(new Float32Array(ev.inputBuffer.getChannelData(0)));
  }
  lp.connect(node); node.connect(sink);
  stream.getAudioTracks()[0].onended = () => { if (listening) stop('The microphone was turned off by the phone. Tap the microphone to start again.'); };
}
function closeMic() {
  try { node && (node.port ? node.port.onmessage = null : node.onaudioprocess = null); } catch (e) {}
  try { stream && stream.getTracks().forEach(t => t.stop()); } catch (e) {}
  try { ctx && ctx.close(); } catch (e) {}
  ctx = stream = node = null; onFrame = null;
}
async function keepAwake(on) {
  try {
    if (on && S.wake && 'wakeLock' in navigator && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); }
    if (!on && wake) { await wake.release(); wake = null; }
  } catch (e) { wake = null; }
}
// (re)build the detectors for the current dhikr
function arm() {
  const k = sk(E0().k), c = calFor(k);
  match = c ? new Voice.Matcher(samples[k].pos.map(r => r.f), c.thr * matchMul()) : null;
  // when matching, the recordings tell sounds apart, so quieter recitation may pass the loudness gate
  if (seg) { seg.o.sens = match ? Math.max(9, sensDb() - 5) : sensDb(); seg.o.gap = S.gap; seg.cancel(); }
  segHit = false; lastHit = lastMiss = null;
  listenHint();
}
const teachBtn = label => '<button class="linkbtn" data-teach>' + (label || 'Teach it') + '</button>';
const canLearn = k => letters(P[base(k)].ar) <= 160; // longer duas are too varied to match; they count by rhythm
function listenHint() {
  const k = E0().k;
  if (!listening) { $('hint').textContent = 'Tap the beads to count, or tap the microphone and recite.'; return; }
  if (match) { $('hint').textContent = 'Counting ' + (S.whisper ? 'whispers' : 'sounds') + ' like your recordings of ' + nameOf(k) + '.'; return; }
  if (S.whisper) {
    $('hint').innerHTML = canLearn(k) ? 'Whisper mode: tap the beads after each of your first ' + LEARN_N + ' so it learns your whisper (' + (pend[sk(k)] || []).length + ' of ' + LEARN_N + '). ' + teachBtn('Teach it now')
      : 'Whisper mode can’t match a dua this long. Tap the beads to count.';
    return;
  }
  const others = voiceProfile() ? 'Voices that don’t sound like you are ignored.' : 'Until then, other voices can count.';
  $('hint').innerHTML = canLearn(k)
    ? 'Learning how you say it: ' + (pend[k] || []).length + ' of ' + LEARN_N + '. ' + others + ' ' + teachBtn('Teach it now')
    : 'Counting by rhythm. ' + others;
}
function listenMsg() { return 'Listening. Recite <b>' + esc(nameOf(E0().k)) + '</b>.'; }
const fbuf = new Array(1500); // last 15 s of frames, for judging a whole stretch of sound
const framesOf = s => { const o = []; for (let i = s.startF; i <= s.endF; i++) { const f = fbuf[i % 1500]; if (f && f.i === i) o.push(f); } return o; };
function onListen(fr) {
  fbuf[fr.i % 1500] = fr;
  if (saying || performance.now() < muteUntil) { seg.cancel(); match && match.reset(); return; }
  const s = seg.push(fr);
  meter(fr);
  if (match) {
    const hit = match.push(fr, seg.speech);
    if (hit) {
      segHit = true; lastHit = { st: hit.st, en: hit.t, at: Date.now() }; lastMiss = null;
      add(1, 'voice');
      setStatus('Counted <span class="muted">· match ' + hit.s.toFixed(1) + ' of ' + match.thr.toFixed(1) + '</span>');
    }
    if (s && !s.rejected) {
      if (!segHit && s.dur >= 250) {
        lastMiss = { st: s.startF, en: s.endF, at: Date.now() };
        if (match.segMin < match.thr * 1.4) setStatus('Heard something close but not counted <span class="muted">(' + match.segMin.toFixed(1) + ' of ' + match.thr.toFixed(1) + ')</span>. Tap the beads if it was one.');
      }
      segHit = false; match.segMin = Infinity;
    }
    return;
  }
  if (!s) return;
  if (s.rejected) { setStatus('That was a long stretch of sound, so it wasn’t counted.'); return; }
  // Whisper mode, not learned yet: without pitch, rhythm alone would count any hiss, so nothing counts by
  // itself. A tap on the beads right after a whisper confirms it and keeps it for learning.
  if (S.whisper) {
    if (s.dur >= 250 && s.dur <= 8000) { lastWhisper = { st: s.startF, en: s.endF, at: Date.now() }; setStatus('Heard a whisper. Tap the beads if that was one.'); }
    return;
  }
  // Not taught: count a stretch of voice about as long as this dhikr usually takes you
  const k = E0().k, L = V.T[k], n = V.N[k] || 0, known = L && n >= 3;
  const lo = known ? L * 0.45 : 280, hi = known ? L * 2.2 : 6000;
  if (s.dur < lo || s.voicedMs < s.dur * 0.25) return; // a cough, click or clatter
  if (s.dur > hi) {
    if (S.split && known && n >= 5) { const m = Math.min(12, Math.round(s.dur / L)); add(m, 'voice'); setStatus('Counted ' + m + ' said without pauses.'); }
    else setStatus('That was longer than usual, so it wasn’t counted. Pause briefly between recitations.');
    return;
  }
  if (Voice.soundsLikeUser(voiceProfile(), framesOf(s)) === false) { setStatus('That didn’t sound like your voice, so it wasn’t counted.'); return; }
  learnLen(k, s.dur); lastHit = { st: s.startF, en: s.endF, at: Date.now(), learn: true };
  add(1, 'voice');
  if (canLearn(k)) {
    const x = clipOf(lastHit);
    if (x) { (pend[k] = pend[k] || []).push({ x, at: Date.now() }); learnFromPending(k).then(listenHint); }
  }
}
async function start() {
  const mic = $('mic');
  mic.classList.add('busy'); setStatus('Starting the microphone…');
  try { await openMic(); } catch (e) { mic.classList.remove('busy'); closeMic(); micError(e); return; }
  mic.classList.remove('busy');
  seg = new Voice.Segmenter({ sens: sensDb(), gap: S.gap, voiced: !S.whisper });
  listening = true; arm();
  mic.classList.add('on'); mic.setAttribute('aria-pressed', 'true'); mic.setAttribute('aria-label', 'Stop counting by voice');
  setStatus(listenMsg());
  keepAwake(true);
  onFrame = onListen;
}
function stop(msg) {
  listening = false; closeMic(); keepAwake(false); seg = match = null;
  const mic = $('mic'); mic.classList.remove('on'); mic.setAttribute('aria-pressed', 'false'); mic.setAttribute('aria-label', 'Start counting by voice');
  $('lv').style.transform = '';
  setStatus(typeof msg === 'string' ? msg : 'Stopped. Tap the microphone to carry on.');
  listenHint();
}
let mT = 0;
function meter(fr) {
  const now = performance.now(); if (now - mT < 50) return; mT = now;
  if (seg.floor == null) return;
  const th = seg.thresholds(), x = Math.max(0, Math.min(1, (fr.db - seg.floor) / (th.on - seg.floor + 8)));
  $('lv').style.transform = 'scale(' + (0.92 + x * 0.22).toFixed(3) + ')';
  $('lv').style.opacity = seg.speech ? 1 : 0.3 + x * 0.4;
}
$('mic').onclick = () => { listening ? stop() : start(); };
document.addEventListener('click', e => { if (e.target.closest('[data-teach]')) openTeach(sk(E0().k), false); });
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
    'Voice settings: sensitivity ' + S.sens + ', pause ' + S.gap + ' ms, split ' + (S.split ? 'on' : 'off') + ', whisper ' + (S.whisper ? 'on' : 'off'),
    'Voice profile: ' + (voiceProfile() ? 'ready (' + profileCount() + ' recordings, pitch ' + Math.round(voiceProfile().f0lo) + '–' + Math.round(voiceProfile().f0hi) + ' Hz)' : profileCount() + ' of 6 recordings'),
    'Taught adhkar: ' + (Object.entries(samples).filter(([, s]) => s.pos.length).map(([k, s]) => nameOf(k) + ' ' + s.pos.length + (s.neg.length ? '/-' + s.neg.length : '') + (calFor(k) ? ' (limit ' + calFor(k).thr.toFixed(1) + ')' : '')).join(', ') || 'none'),
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
    onFrame = fr => { const db = fr.db; floor = floor == null ? db : Math.min(floor + 0.05, db < floor ? db : floor); const x = Math.max(0, Math.min(1, (db - floor) / 30)); best = Math.max(best, x); const el = $('diagLv'); if (el) el.style.width = (x * 100).toFixed(0) + '%'; };
    await new Promise(r => setTimeout(r, 6000));
    closeMic();
    $('diagMic').textContent = best > 0.3 ? 'It hears you. Test again' : 'Barely heard anything. Test again';
  } catch (e) { closeMic(); $('diagMic').textContent = 'Couldn’t open the microphone'; micError(e); }
  testing = false; $('diagMic').disabled = false;
}

// ---------- teach it a dhikr / train my voice ----------
// 2 s of quiet sets the room level, then recitations become recordings. For a dhikr (5 of them) they're what
// it matches against. For "Train my voice" (k = '_voice', 8 of any adhkar) they only build the voice profile.
let teaching = null;
const median = a => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
function dots(n, N) { $('tuneDots').innerHTML = '<i></i>'.repeat(N); [...$('tuneDots').children].forEach((d, i) => d.classList.toggle('on', i < n)); }
function openTeach(k, thenListen) {
  if (listening) stop();
  const general = k === '_voice', N = general ? 8 : 5;
  teaching = { k, thenListen, N };
  const have = samples[k] ? samples[k].pos.length : 0, name = general ? 'your voice' : nameOf(k);
  $('tuneTitle').textContent = general ? 'Train my voice' : 'Teach it ' + name + (k.endsWith('~w') ? ' in a whisper' : '');
  if (general) {
    $('tuneMsg').textContent = have ? 'It has ' + profileCount() + ' recordings of your voice' : 'Teach it what your voice sounds like';
    $('tuneSub').textContent = 'Stay quiet for 2 seconds, then say any adhkar 8 times with a short pause after each: SubhanAllah, Alhamdulillah, Allahu Akbar, whatever you like. After that, voices that don’t sound like you (other people, the TV) aren’t counted, even for adhkar it hasn’t learned yet.';
  } else {
    $('tuneMsg').textContent = have >= 3 ? 'It already knows ' + have + ' of your recordings' : 'Teach it how you say this';
    $('tuneSub').textContent = 'Stay quiet for 2 seconds, then say ' + name + ' 5 times with a short pause between each. After that it only counts sounds like yours. (It also learns by itself from your first 5 recitations.)';
  }
  dots(0, N); $('tuneThr').hidden = true; $('tuneLv').style.width = '0';
  $('tuneGo').textContent = have >= 3 ? 'Record ' + N + ' more' : 'Begin'; $('tuneGo').disabled = false; $('tuneGo').onclick = runTeach;
  const alt = $('tuneAlt'); alt.hidden = false; delete alt.dataset.armed;
  if (thenListen) { alt.textContent = 'Not now'; alt.onclick = () => { closeSheet(); start(); }; }
  else if (have) {
    alt.textContent = 'Forget these recordings';
    alt.onclick = async () => {
      if (alt.dataset.armed !== '1') { alt.dataset.armed = '1'; alt.textContent = 'Tap again to forget them'; return; }
      await dropSamples(k); toast('Forgot the recordings of ' + name); closeSheet();
    };
  } else { alt.textContent = 'Not now'; alt.onclick = closeSheet; }
  openSheet('tune');
}
async function runTeach() {
  const tc = teaching; if (!tc) return;
  $('tuneGo').disabled = true; $('tuneAlt').hidden = true;
  try { await openMic(); } catch (e) { closeSheet(); micError(e); return; }
  const k = tc.k, N = tc.N, general = k === '_voice', name = general ? 'any adhkar' : nameOf(k), quiet = [], durs = [], gaps = [], peaks = [];
  let t0 = null, phase = 'quiet', sg = null, lastEnd = null, got = 0, floor = 0;
  tc.active = true;
  $('tuneMsg').textContent = 'Stay quiet…'; dots(0, N);
  const finish = ok => {
    if (phase === 'done') return; phase = 'done';
    onFrame = null; closeMic(); tc.active = false;
    $('tuneGo').disabled = false; $('tuneAlt').hidden = false;
    if (!ok) {
      $('tuneMsg').textContent = got ? 'Only ' + got + ' heard clearly' : 'I couldn’t hear you clearly';
      $('tuneSub').textContent = got ? 'It needs at least 3. Hold the phone a little closer and pause briefly between each.' : 'Check the microphone isn’t covered, or use Check my setup in Settings.';
      $('tuneGo').textContent = 'Try again'; $('tuneGo').onclick = runTeach;
      $('tuneAlt').textContent = 'Not now'; $('tuneAlt').onclick = closeSheet;
      return;
    }
    // sensitivity halfway between the room and your voice; pause about half your usual breath
    const want = Math.max(10, Math.min(24, Math.min(tc.sens, (median(peaks) - floor) * 0.5)));
    S.sens = Math.round(Math.max(0, Math.min(100, (24 - want) / 0.14)));
    if (gaps.length) S.gap = Math.round(Math.max(250, Math.min(600, median(gaps) * 0.6)) / 10) * 10;
    if (!general) { V.T[k] = Math.round(median(durs)); V.N[k] = Math.max(V.N[k] || 0, 3); delete pend[k]; }
    saveVoice(); saveSettings(); calCache = {}; profCache = undefined;
    $('tuneMsg').textContent = 'Ready';
    if (general) {
      $('tuneSub').textContent = voiceProfile() ? 'It knows your voice now. Voices that don’t sound like you won’t count. Each dhikr still learns your exact words from your first 5 recitations.' : 'Saved. A few more recordings and the voice profile will be ready.';
      $('tuneGo').textContent = 'Done'; $('tuneGo').onclick = closeSheet; $('tuneAlt').hidden = true;
      return;
    }
    const c = calFor(k);
    $('tuneSub').textContent = 'It now counts only sounds like your ' + samples[k].pos.length + ' recordings of ' + name + '. If it misses one, tap the beads and it will offer to learn from it; if it counts something wrong, Undo teaches it that too.' + (c && c.minNeg < c.thr * 1.2 ? ' It sounds close to another dhikr you taught, so it will be strict.' : '');
    $('tuneGo').textContent = 'Start counting'; $('tuneGo').onclick = () => { closeSheet(); start(); };
    $('tuneAlt').textContent = 'Done'; $('tuneAlt').onclick = closeSheet;
  };
  onFrame = fr => {
    if (t0 == null) t0 = fr.i;
    const el = (fr.i - t0) * 10;
    $('tuneLv').style.width = Math.max(0, Math.min(100, (fr.db + 90) * 1.4)).toFixed(0) + '%';
    if (phase === 'quiet') {
      quiet.push(fr.db);
      $('tuneSub').textContent = Math.max(1, Math.ceil((2000 - el) / 1000)) + '…';
      if (el >= 2000) {
        const s = quiet.slice(10).sort((a, b) => a - b);
        floor = s[Math.floor(s.length * 0.5)];
        tc.sens = Math.max(12, Math.min(24, s[Math.floor(s.length * 0.95)] - floor + 9));
        sg = new Voice.Segmenter({ sens: tc.sens, gap: 300, voiced: !k.endsWith('~w') }); sg.floor = floor;
        $('tuneThr').hidden = false; $('tuneThr').style.left = Math.max(0, Math.min(100, (floor + tc.sens + 90) * 1.4)) + '%';
        phase = 'speak'; t0 = fr.i;
        $('tuneMsg').textContent = 'Now say ' + name; $('tuneSub').textContent = '1 of ' + N;
        $('tuneGo').textContent = 'Finish'; $('tuneGo').onclick = () => finish(got >= 3);
      }
      return;
    }
    if (phase !== 'speak') return;
    if (el > 60000) return finish(got >= 3);
    const s = sg.push(fr);
    if (!s || s.rejected || s.dur < 250 || !k.endsWith('~w') && s.voicedMs < s.dur * 0.25) return;
    const x = front.clip(Math.max(0, s.startF - 5), s.endF + 5); if (!x) return;
    const y = Voice.trim(x); if (y.length < Voice.SR * 0.25) return;
    saveSample(k, y, false); got++;
    durs.push(s.dur); peaks.push(s.peak); if (lastEnd != null) gaps.push((s.startF - lastEnd) * 10); lastEnd = s.endF;
    dots(got, N); $('tuneSub').textContent = got < N ? (got + 1) + ' of ' + N : '';
    if (got >= 3) $('tuneGo').disabled = false;
    if (got >= N) finish(true);
  };
}
$('tuneBtn').onclick = () => { closeSheet(); openTeach(sk(E0().k), false); };
$('voiceBtn').onclick = () => { closeSheet(); openTeach('_voice', false); };

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
  if (seg) seg.cancel(); if (match) match.reset();
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
        const tg = isFinite(target(e)) ? target(e) : '∞';
        b.children[1].textContent = fin ? '✓' : count(e) ? count(e) + '/' + tg : '×' + tg;
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
  if (openId === 'tune' && teaching && teaching.active) { onFrame = null; closeMic(); teaching.active = false; }
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
// Corrections teach the matcher: a tap just after an uncounted sound offers to save it as a recording,
// and undoing a voice count saves that sound as "not this" (only when the dhikr is taught).
const fresh = h => h && Date.now() - h.at < 15000;
function clipOf(h) { const x = front && front.clip(Math.max(0, h.st - 5), h.en + 5); if (!x) return null; const y = Voice.trim(x); return y.length >= Voice.SR * 0.25 && y.length <= Voice.SR * 8 ? y : null; }
$('ring').onclick = () => {
  add(1, 'tap');
  const k = sk(E0().k);
  // whisper mode learns from tapped whispers: a tap within 4 s of one confirms it
  if (listening && S.whisper && !match && canLearn(k) && lastWhisper && Date.now() - lastWhisper.at < 4000) {
    const x = clipOf(lastWhisper); lastWhisper = null;
    if (x) { (pend[k] = pend[k] || []).push({ x, at: Date.now() }); learnFromPending(k).then(listenHint); listenHint(); setStatus('Kept that whisper for learning.'); }
    return;
  }
  if (!listening || !match || !fresh(lastMiss)) return;
  const x = clipOf(lastMiss); lastMiss = null; if (!x) return;
  toast('Missed one? Save that sound as a recording of ' + nameOf(k) + '.', 'Save it', async () => { await saveSample(k, x, false); arm(); toast('Saved. It knows ' + samples[k].pos.length + ' recordings now.'); });
};
$('undo').onclick = async () => {
  const wasVoice = lastAdd && lastAdd.how === 'voice';
  add(-1, 'tap'); lastAdd = null;
  const k = sk(E0().k);
  if (!wasVoice) { // undoing a tap that kept a whisper for learning: forget that whisper too
    if (S.whisper && !match && pend[k] && pend[k].length && Date.now() - pend[k][pend[k].length - 1].at < 15000) { pend[k].pop(); listenHint(); }
    return;
  }
  if (listening && fresh(lastHit)) {
    // while learning, the undone sound must not become one of its recordings
    if (lastHit.learn && pend[k] && pend[k].length) pend[k].pop();
    const x = clipOf(lastHit); lastHit = null;
    if (x) { await saveSample(k, x, true); if (match) arm(); else listenHint(); setStatus('Undone. It will be stricter about that sound.'); return; }
  }
  setStatus('Undone.');
};
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
  for (const id of ['split', 'whisper', 'vib', 'click', 'wake', 'showTr', 'showEn', 'auto']) $(id).checked = !!S[id];
  $('sens').value = S.sens; $('gap').value = S.gap;
  $('gapTxt').textContent = 'Counts after ' + (S.gap / 1000).toFixed(2) + ' s of quiet. Raise it if one long phrase counts as two.';
  const changed = Object.keys(st.n).length;
  $('targetTxt').textContent = 'Set your own count for this dhikr, this list or everything, or count with no limit.' + (changed ? ' ' + changed + ' changed from the usual.' : '');
  $('vibNote').hidden = !IOS; $('ver').textContent = APP_VERSION;
  const k = sk(E0().k), n = samples[k] ? samples[k].pos.length : 0, pc = profileCount();
  $('voiceTxt').textContent = voiceProfile() ? 'Ready, from ' + pc + ' recordings of you. Voices that don’t sound like you aren’t counted, even for adhkar it hasn’t learned yet.'
    : 'Optional, one minute. Say any adhkar 8 times so other people and the TV don’t count. It also builds itself as you recite (' + pc + ' of 6 recordings so far).';
  $('voiceBtn').textContent = voiceProfile() ? 'More' : 'Train';
  $('teachName').textContent = 'Teach it ' + nameOf(k);
  $('teachTxt').textContent = n >= 3 ? 'Learned from ' + n + ' of your recordings. Only sounds like them count.'
    : canLearn(k) ? 'Learns by itself from your first ' + LEARN_N + ' recitations (' + (pend[k] || []).length + ' so far), or teach it now.' : 'Too long to match, so it counts by rhythm.';
  $('tuneBtn').textContent = n >= 3 ? 'Manage' : 'Teach';
  $('tuneBtn').disabled = !canLearn(k) && !n;
}
for (const id of ['split', 'whisper', 'vib', 'click', 'wake', 'showTr', 'showEn', 'auto']) $(id).onchange = () => {
  S[id] = $(id).checked; saveSettings();
  if (id === 'wake') keepAwake(listening);
  if (id === 'whisper') { fillSettings(); if (listening) { stop(); start(); } } // the microphone opens differently for whispers
};
$('sens').oninput = () => { S.sens = +$('sens').value; saveSettings(); if (listening) arm(); };
$('gap').oninput = () => { S.gap = +$('gap').value; saveSettings(); fillSettings(); if (listening) arm(); };
// ---------- targets ----------
let tgtScope = 'one';
const scopeEntries = () => tgtScope === 'all' ? E : tgtScope === 'cat' ? entriesOf(E0().cat) : [E0()];
function openTarget() {
  const e = E0(), t = target(e);
  $('tgtFor').textContent = tgtScope === 'all' ? 'Every dhikr in every list (' + E.length + ').'
    : tgtScope === 'cat' ? 'All ' + entriesOf(e.cat).length + ' in ' + catOf(e.cat).name + '.' : nameOf(e.k) + ' · usually ' + e.n + '.';
  document.querySelectorAll('#tgtScope [data-scope]').forEach(b => b.setAttribute('aria-checked', b.dataset.scope === tgtScope));
  const opts = [1, 3, 7, 10, 33, 34, 99, 100, 313, 500, 1000];
  $('tgtChips').innerHTML = opts.map(v => '<button data-v="' + v + '"' + (tgtScope === 'one' && t === v ? ' class="on"' : '') + '>' + v + '</button>').join('') +
    '<button class="wide' + (tgtScope === 'one' && !isFinite(t) ? ' on' : '') + '" data-v="' + NOLIMIT + '">No limit</button>';
  $('tgtChips').querySelectorAll('[data-v]').forEach(b => b.onclick = () => setTarget(+b.dataset.v));
  $('tgtN').value = tgtScope === 'one' && isFinite(t) && !opts.includes(t) ? t : '';
  openSheet('tgt');
}
function setTarget(v) {
  const list = scopeEntries();
  for (const e of list) { if (v === e.n) delete st.n[e.key]; else st.n[e.key] = v; }
  saveState(); closeSheet();
  const what = v === NOLIMIT ? 'no limit' : v;
  toast(list.length === 1 ? 'Target for ' + nameOf(list[0].k) + ': ' + what : 'Target set to ' + what + ' for ' + list.length + ' adhkar');
}
document.querySelectorAll('#tgtScope [data-scope]').forEach(b => b.onclick = () => { tgtScope = b.dataset.scope; openTarget(); });
$('tgtForm').onsubmit = ev => { ev.preventDefault(); const v = parseInt($('tgtN').value); if (v >= 1 && v <= 100000) setTarget(v); };
$('tgtReset').onclick = () => { const list = scopeEntries(); for (const e of list) delete st.n[e.key]; saveState(); closeSheet(); toast('Usual target' + (list.length > 1 ? 's' : '') + ' restored'); };
$('targetBtn').onclick = () => { tgtScope = 'one'; openTarget(); };
$('targetSet').onclick = () => { tgtScope = 'cat'; openTarget(); };
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
function toast(msg, act, fn) {
  const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT);
  if (act) { const b = document.createElement('button'); b.className = 'tact'; b.textContent = act; b.onclick = () => { t.hidden = true; fn(); }; t.appendChild(b); }
  toastT = setTimeout(() => { t.hidden = true; }, act ? 9000 : 2600);
}

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
window.__tasbeeh = { Voice, P, E: () => E, go: key => select(E.findIndex(e => e.key === key)), samples, calFor };
document.documentElement.dataset.ready = '1';
render(); suggest(); showEnvBanner(); loadSamples();
if (!load('welcomed', false)) welcome();
addEventListener('load', checkUpdate);
micPermission().then(p => { if (p === 'denied') setStatus('The microphone is blocked for this site. <button class="linkbtn" data-help>How to fix</button>', true); });
