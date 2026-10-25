'use strict';
// Voice engine. Microphone audio (16 kHz) becomes 10 ms frames: 12 MFCCs (shape of the sound), loudness, and
// voicing (how strongly pitched it is, so clatter and hiss can't count). Two detectors use the frames:
//  - Segmenter: finds stretches of pitched voice separated by pauses (used to count when nothing is taught yet,
//    and to record samples when teaching).
//  - Matcher: compares the live frames with the user's own recordings of a dhikr (open-start subsequence DTW,
//    "SPRING"), so only sounds like those recordings count. Back-to-back recitation works without pauses.
// Everything runs on the phone; no audio is sent anywhere.
const Voice = (() => {
  const SR = 16000, HOP = 160, FL = 400, NFFT = 512, NMEL = 26, NCEP = 12, PW = 640;
  const HAMM = Float32Array.from({ length: FL }, (_, i) => 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (FL - 1)));
  const MELS = (() => {
    const m = f => 2595 * Math.log10(1 + f / 700), im = x => 700 * (10 ** (x / 2595) - 1), lo = m(100), hi = m(3800), p = [];
    for (let i = 0; i < NMEL + 2; i++) p.push(Math.floor((NFFT + 1) * im(lo + (hi - lo) * i / (NMEL + 1)) / SR));
    const fb = [];
    for (let k = 1; k <= NMEL; k++) {
      const w = new Float32Array(NFFT / 2 + 1);
      for (let b = p[k - 1]; b < p[k]; b++) w[b] = (b - p[k - 1]) / ((p[k] - p[k - 1]) || 1);
      for (let b = p[k]; b <= p[k + 1]; b++) w[b] = (p[k + 1] - b) / ((p[k + 1] - p[k]) || 1);
      fb.push(w);
    }
    return fb;
  })();
  const DCT = Array.from({ length: NCEP }, (_, j) => Float32Array.from({ length: NMEL }, (_, k) => Math.cos(Math.PI * (j + 1) * (k + 0.5) / NMEL)));
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let len = 2; len <= n; len <<= 1) {
      const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a), h = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let j = 0; j < h; j++) {
          const k = i + j + h, tr = re[k] * cr - im[k] * ci, ti = re[k] * ci + im[k] * cr;
          re[k] = re[i + j] - tr; im[k] = im[i + j] - ti; re[i + j] += tr; im[i + j] += ti;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }
  const fre = new Float64Array(NFFT), fim = new Float64Array(NFFT), mel = new Float64Array(NMEL), half = new Float32Array(PW / 2);
  // one 10 ms frame from a window of PW samples: MFCCs from the first FL, voicing from all of it
  function analyse(w) {
    let s = 0; fre.fill(0); fim.fill(0);
    for (let i = 0; i < FL; i++) { const v = w[i]; s += v * v; fre[i] = (v - 0.97 * (i ? w[i - 1] : 0)) * HAMM[i]; }
    fft(fre, fim);
    let top = 0;
    for (let k = 0; k < NMEL; k++) { const f = MELS[k]; let e = 0; for (let b = 0; b <= NFFT / 2; b++) if (f[b]) e += f[b] * (fre[b] * fre[b] + fim[b] * fim[b]); mel[k] = e; if (e > top) top = e; }
    // keep only the loudest 30 dB of each frame, so faint background noise doesn't change the shape
    for (let k = 0; k < NMEL; k++) mel[k] = Math.log(mel[k] + top * 1e-3 + 1e-9);
    const c = new Float32Array(NCEP); // c0 is dropped, so loudness doesn't change the shape
    for (let j = 0; j < NCEP; j++) { let v = 0; for (let k = 0; k < NMEL; k++) v += DCT[j][k] * mel[k]; c[j] = v; }
    // voicing: peak normalised autocorrelation for pitches 70-400 Hz, on the window halved to 8 kHz
    for (let i = 0; i < PW / 2; i++) half[i] = (w[2 * i] + w[2 * i + 1]) * 0.5;
    let best = 0, bestLag = 0;
    const N = PW / 2;
    for (let lag = 20; lag <= 114; lag++) {
      let xy = 0, xx = 0, yy = 0;
      for (let i = 0; i + lag < N; i++) { const a = half[i], b = half[i + lag]; xy += a * b; xx += a * a; yy += b * b; }
      const r = xy / Math.sqrt(xx * yy + 1e-12);
      if (r > best) { best = r; bestLag = lag; }
    }
    return { c, db: 10 * Math.log10(s / FL + 1e-12), v: best, f0: bestLag ? 8000 / bestLag : 0 };
  }

  // Streaming resampler to 16 kHz (linear; the band above 3.8 kHz is already filtered out)
  class Resampler {
    constructor(from) { this.r = from / SR; this.t = 0; this.prev = 0; }
    push(x) {
      const out = []; let t = this.t;
      while (t < x.length - 1) { const i = Math.floor(t), f = t - i, a = i < 0 ? this.prev : x[i], b = x[i + 1]; out.push(a + (b - a) * f); t += this.r; }
      this.t = t - x.length; this.prev = x[x.length - 1];
      return Float32Array.from(out);
    }
  }

  // Front end: keeps the last 12 s of audio and emits a frame every 10 ms. Frame i covers samples i*HOP onwards.
  class Front {
    constructor() { this.ring = new Float32Array(SR * 12); this.n = 0; this.i = 0; this.w = new Float32Array(PW); }
    push(x) {
      const R = this.ring.length, out = [];
      // write in slices and analyse as we go, so a long recording can't overwrite audio not yet analysed
      for (let o = 0; o < x.length; o += 8192) {
        const part = x.subarray(o, Math.min(x.length, o + 8192));
        for (let k = 0; k < part.length; k++) this.ring[(this.n + k) % R] = part[k];
        this.n += part.length;
        while (this.i * HOP + PW <= this.n) {
          const s = this.i * HOP;
          for (let k = 0; k < PW; k++) this.w[k] = this.ring[(s + k) % R];
          const f = analyse(this.w); f.i = this.i++; out.push(f);
        }
      }
      return out;
    }
    clip(f0, f1) { // audio of frames f0..f1, if still in the buffer
      const a = f0 * HOP, b = Math.min(f1 * HOP + FL, this.n), R = this.ring.length;
      if (a < this.n - R || b <= a) return null;
      const o = new Float32Array(b - a); for (let k = a; k < b; k++) o[k - a] = this.ring[k % R]; return o;
    }
  }
  const frames = x => { const f = new Front(); return f.push(x); };
  // MFCC frames of a recording with the quiet edges removed, so back-to-back recitations (no silence between)
  // match as well as separate ones
  function template(x) {
    const fs = frames(x); if (!fs.length) return [];
    const top = Math.max(...fs.map(f => f.db)), keep = f => f.db > top - 22;
    let a = fs.findIndex(keep), b = fs.length - 1; while (b > a && !keep(fs[b])) b--;
    return fs.slice(Math.max(0, a), b + 1).map(f => f.c);
  }

  // Finds stretches of pitched voice. A frame is speech if it's loud enough above the room and pitch was heard
  // within the last 120 ms (consonants between vowels). A stretch ends after `gap` ms without speech.
  class Segmenter {
    constructor(o) { this.o = Object.assign({ sens: 17, gap: 350, maxMs: 12000 }, o); this.floor = null; this.init = []; this.active = false; this.lastVoiced = -1e9; this.lastSpeech = -1e9; this.speech = false; }
    thresholds() { return { on: this.floor + this.o.sens, off: this.floor + this.o.sens * 0.65 }; }
    push(fr) {
      const t = fr.i * 10;
      if (this.floor == null) { // learn the room for the first 300 ms
        this.init.push(fr.db); this.speech = false;
        if (this.init.length >= 30) { const s = this.init.slice().sort((a, b) => a - b); this.floor = s[Math.floor(s.length * 0.4)]; }
        return null;
      }
      const th = this.thresholds(), loud = fr.db > (this.active ? th.off : th.on);
      if (fr.v > 0.5 && fr.db > th.off) this.lastVoiced = t;
      const speech = this.speech = loud && t - this.lastVoiced <= 120;
      if (speech) {
        if (!this.active) { this.active = true; this.start = t; this.startF = fr.i; this.speechMs = 0; this.voicedMs = 0; this.peak = -200; }
        this.lastSpeech = t; this.endF = fr.i; this.speechMs += 10; if (fr.v > 0.5) this.voicedMs += 10; if (fr.db > this.peak) this.peak = fr.db;
      }
      if (this.active) {
        if (t - this.start > this.o.maxMs) { // far too long for one recitation: talking, or a steady sound
          if (this.speechMs > 0.85 * (t - this.start)) this.floor = Math.max(this.floor, fr.db - 3);
          this.active = false; return { rejected: 'long', dur: t - this.start };
        }
        if (!speech && t - this.lastSpeech >= this.o.gap) {
          this.active = false;
          return { startF: this.startF, endF: this.endF, dur: this.lastSpeech - this.start + 10, speechMs: this.speechMs, voicedMs: this.voicedMs, peak: this.peak };
        }
        return null;
      }
      // between sounds, follow the room: quickly down, slowly up
      this.floor += (fr.db - this.floor) * (fr.db < this.floor ? 0.1 : 0.002);
      return null;
    }
    cancel() { this.active = false; }
  }

  // ---- DTW matching against the user's own recordings ----
  function dist(a, b) { let s = 0; for (let i = 0; i < NCEP; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); }
  function newPath(f) { const M = f.length; return { f, D: new Float64Array(M + 1).fill(Infinity), L: new Int32Array(M + 1), S: new Int32Array(M + 1) }; }
  // One frame of open-start subsequence DTW: best match of the template ending at frame t, as
  // [average frame distance, start frame], or [Infinity] if the match is squashed or stretched more than 2x.
  function step(p, c, t) {
    const { f, D, L, S } = p, M = f.length;
    let pD = 0, pL = 0, pS = t;
    D[0] = 0; L[0] = 0; S[0] = t;
    for (let i = 1; i <= M; i++) {
      const oD = D[i], oL = L[i], oS = S[i];
      let bD = pD, bL = pL, bS = pS;
      if (oD < bD) { bD = oD; bL = oL; bS = oS; }
      if (D[i - 1] < bD) { bD = D[i - 1]; bL = L[i - 1]; bS = S[i - 1]; }
      D[i] = bD + dist(c, f[i - 1]); L[i] = bL + 1; S[i] = bS;
      pD = oD; pL = oL; pS = oS;
    }
    const dur = t - S[M] + 1;
    if (D[M] === Infinity || dur < 0.5 * M || dur > 2 * M) return [Infinity];
    return [D[M] / L[M], S[M]];
  }
  function bestScore(tpl, seq) { const p = newPath(tpl); let b = Infinity; for (let t = 0; t < seq.length; t++) { const s = step(p, seq[t], t)[0]; if (s < b) b = s; } return b; }
  const pct = (a, q) => a[Math.min(a.length - 1, Math.floor(q * (a.length - 1) + 0.5))];
  // Threshold from the samples: how well each matches the others (leave-one-out), tightened if sounds that are
  // not this dhikr (other adhkar, and sounds the user undid) come too close.
  function calibrate(pos, neg) {
    if (pos.length < 3) return null;
    const sc = pos.map((s, j) => Math.min(...pos.filter((_, k) => k !== j).map(o => bestScore(o, s)))).sort((a, b) => a - b);
    // In tests, other phrases and other speech scored 3.5x or more of how far your own recordings are from each
    // other, and your own voice in a noisy room up to 2.5x. So the limit sits in between, and moves halfway
    // towards the closest known wrong sound when there is one.
    const p90 = pct(sc, 0.9);
    let thr = p90 * 1.8, minNeg = Infinity;
    for (const s of neg) for (const o of pos) minNeg = Math.min(minNeg, bestScore(o, s));
    if (minNeg < Infinity) thr = Math.max(p90 * 1.15, Math.min(thr, Math.sqrt(p90 * minNeg)));
    return { thr, lo: sc[0], hi: sc[sc.length - 1], minNeg, len: pct(pos.map(p => p.length).sort((a, b) => a - b), 0.5) };
  }
  // Live matcher. Counts at the lowest score once it hasn't improved for 120 ms; paths that started before
  // that are cleared so one recitation counts once. At least half of a match must be speech.
  class Matcher {
    constructor(tpls, thr) { this.p = tpls.map(newPath); this.thr = thr; this.cand = null; this.last = -1; this.sp = new Uint8Array(4096); this.segMin = Infinity; }
    speechFrac(a, b) { a = Math.max(a, b - 4095); let v = 0; for (let t = a; t <= b; t++) v += this.sp[t & 4095]; return v / (b - a + 1); }
    reset() { for (const p of this.p) p.D.fill(Infinity); this.cand = null; }
    push(fr, speech) {
      const t = fr.i; this.sp[t & 4095] = speech ? 1 : 0;
      let best = Infinity, bs = 0;
      for (const p of this.p) { const [s, st] = step(p, fr.c, t); if (s < best) { best = s; bs = st; } }
      if (speech && best < this.segMin) this.segMin = best;
      if (best < this.thr && bs > this.last && this.speechFrac(bs, t) >= 0.5 && (!this.cand || best < this.cand.s)) this.cand = { s: best, t, st: bs };
      if (this.cand && t - this.cand.t >= 12) {
        const c = this.cand; this.cand = null; this.last = c.t;
        for (const p of this.p) for (let i = 1; i < p.D.length; i++) if (p.S[i] <= c.t) p.D[i] = Infinity;
        return c;
      }
      return null;
    }
  }
  // ---- voice profile: what the user's voice sounds like, whatever they are saying ----
  // Per recording: average MFCCs and median pitch of its voiced frames.
  function voiceStats(fs) {
    const vf = fs.filter(f => f.v > 0.5 && f.f0 > 0); if (vf.length < 8) return null;
    const mu = new Float32Array(NCEP); for (const f of vf) for (let j = 0; j < NCEP; j++) mu[j] += f.c[j] / vf.length;
    const p = vf.map(f => f.f0).sort((a, b) => a - b);
    return { mu, f0: p[Math.floor(p.length / 2)] };
  }
  // From many recordings (different adhkar are fine): spread of the averages, pitch range, and a distance limit
  // set from how far the user's own recordings fall from the profile.
  function profile(stats) {
    stats = stats.filter(Boolean); if (stats.length < 6) return null;
    const n = stats.length, mu = new Float32Array(NCEP), sd = new Float32Array(NCEP);
    for (const s of stats) for (let j = 0; j < NCEP; j++) mu[j] += s.mu[j] / n;
    for (const s of stats) for (let j = 0; j < NCEP; j++) sd[j] += (s.mu[j] - mu[j]) ** 2 / n;
    for (let j = 0; j < NCEP; j++) sd[j] = Math.max(0.35, Math.sqrt(sd[j]));
    const P = { mu, sd, f0lo: 0, f0hi: 0, thr: 0 };
    const d = stats.map(s => voiceDist(P, s)).sort((a, b) => a - b), f = stats.map(s => s.f0).sort((a, b) => a - b);
    P.thr = Math.max(1.6, pct(d, 0.95) * 1.5);
    P.f0lo = pct(f, 0.05) * 0.75; P.f0hi = pct(f, 0.95) * 1.3;
    return P;
  }
  function voiceDist(P, s) { let t = 0; for (let j = 0; j < NCEP; j++) t += ((s.mu[j] - P.mu[j]) / P.sd[j]) ** 2; return Math.sqrt(t / NCEP); }
  // Does a stretch of sound sound like the user? true / false, or null if it can't tell.
  // In tests the average MFCCs depended more on the words than on the speaker (your own voice saying a new
  // dhikr was further from the profile than another speaker), so pitch range decides and the MFCC distance
  // is only a loose check against sounds that aren't speech at all.
  function soundsLikeUser(P, fs) {
    const s = voiceStats(fs); if (!P || !s) return null;
    return s.f0 >= P.f0lo && s.f0 <= P.f0hi && voiceDist(P, s) <= P.thr * 2.5;
  }
  // the recordings that agree with each other (drops a cough or a misheard sound picked up while learning)
  function consistent(tpls) {
    const n = tpls.length, med = [];
    for (let i = 0; i < n; i++) { const d = []; for (let j = 0; j < n; j++) if (j !== i) d.push(bestScore(tpls[j], tpls[i])); d.sort((a, b) => a - b); med.push(d[Math.floor(d.length / 2)]); }
    const m = med.slice().sort((a, b) => a - b)[Math.floor(n / 2)];
    return tpls.map((_, i) => i).filter(i => med[i] <= m * 1.4);
  }
  const toInt16 = x => Int16Array.from(x, v => Math.max(-32768, Math.min(32767, Math.round(v * 32768))));
  const fromInt16 = a => Float32Array.from(a, v => v / 32768);
  // cut quiet lead-in and tail off a recording
  function trim(x) {
    const r = []; for (let o = 0; o + FL <= x.length; o += HOP) { let s = 0; for (let i = 0; i < FL; i++) s += x[o + i] * x[o + i]; r.push(Math.sqrt(s / FL)); }
    const th = Math.max(Math.max(...r, 0) * 0.06, 0.002);
    let a = r.findIndex(v => v > th), b = r.length - 1; while (b > 0 && r[b] <= th) b--;
    if (a < 0) return new Float32Array(0);
    a = Math.max(0, a - 3); b = Math.min(r.length - 1, b + 3);
    return x.slice(a * HOP, b * HOP + FL);
  }

  // Samples live in IndexedDB as 16 kHz Int16 audio: {id, k: dhikr key, neg: "not this" sound, a, at}
  let dbp = null;
  function idb(rw, fn) {
    dbp = dbp || new Promise((res, rej) => { const r = indexedDB.open('tasbeeh2', 1); r.onupgradeneeded = () => r.result.createObjectStore('samples', { keyPath: 'id', autoIncrement: true }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    return dbp.then(d => new Promise((res, rej) => { const tx = d.transaction('samples', rw), q = fn(tx.objectStore('samples')); tx.oncomplete = () => res(q.result); tx.onerror = () => rej(tx.error); }));
  }
  const store = {
    all: () => idb('readonly', s => s.getAll()),
    add: rec => idb('readwrite', s => s.add(rec)),
    del: id => idb('readwrite', s => s.delete(id)),
  };
  // samples recorded with the old app (database "tasbeeh"), without creating that database if it doesn't exist
  function oldSamples() {
    return new Promise(res => {
      let r; try { r = indexedDB.open('tasbeeh'); } catch (e) { return res([]); }
      r.onupgradeneeded = e => { e.target.transaction.abort(); };
      r.onerror = () => res([]);
      r.onsuccess = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('samples')) { d.close(); return res([]); }
        const q = d.transaction('samples', 'readonly').objectStore('samples').getAll();
        q.onsuccess = () => { d.close(); res(q.result || []); }; q.onerror = () => { d.close(); res([]); };
      };
    });
  }
  return { SR, Resampler, Front, frames, template, Segmenter, Matcher, calibrate, bestScore, voiceStats, profile, voiceDist, soundsLikeUser, consistent, trim, toInt16, fromInt16, store, oldSamples };
})();
