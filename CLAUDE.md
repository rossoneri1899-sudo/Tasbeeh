# Hands-free Tasbeeh — project notes

A web app that counts tasbeeh (Islamic phrases of remembrance) by listening to the user recite, instead of tapping. Everything lives in a single file, `index.html`, hosted on GitHub Pages and used on an iPhone in Safari (added to the home screen).

## Constraints (read first)

- **The owner uses an iPhone and has no Mac.** A native iOS app is off the table for now. Everything must work as a web page in iOS Safari.
- **Hosted on GitHub Pages** from the `main` branch root. Deploying = committing `index.html` to `main`. **Bump `APP_VERSION` in `index.html` on every deploy**: the page fetches the live copy (no-store) on launch and whenever it returns to the foreground, and shows a "new version, tap to update" banner if the number differs. This exists because iOS resumes home-screen apps from memory instead of reloading them. The version is shown at the bottom of the page, so ask the owner which number they see when an update seems missing.
- **On-device only.** No audio may leave the phone. Do not add server-side speech APIs.
- **Do not use the Web Speech API** (`SpeechRecognition` / `webkitSpeechRecognition`). It is unavailable or blocked on iPhone; this was the first approach and it failed.
- **Single self-contained file.** Keep markup, styles and script in `index.html`. External scripts only from a CDN. Exception: files browsers require to be separate — `sw.js` (service worker), `manifest.webmanifest`, and the icons `icon-180.png` / `icon-192.png` / `icon-512.png`.
- The owner tests on their phone and reports back. There is no automated test setup, so keep changes small and easy to verify by hand. After each deploy, remind them to reload with a new `?v=N` query string, because Safari caches the old page. (The service worker is network-first, so this matters less now, but it is still the safe advice.)

## How it works now

- **Offline / home screen:** `manifest.webmanifest` + `apple-touch-icon` (prayer-bead icon). `sw.js` caches the page network-first with `cache:'no-cache'` (GitHub Pages sends `max-age=600`, which otherwise served stale pages for 10 min), 4 s timeout, ignores `?v=N`, and `cdn.jsdelivr.net` cache-first; it precaches the transformers.js entry. Whisper model files are cached by transformers.js itself (`transformers-cache`), which the SW never deletes. Bump `CACHE` in `sw.js` when its caching rules change. transformers.js is loaded with a dynamic `import()` inside `loadModel()`, so voice-sample counting works even if the CDN is unreachable.
- **Speech engine:** Whisper tiny (`Xenova/whisper-tiny`, q8) running in the page via transformers.js (`@huggingface/transformers@3.5.1` from jsDelivr). ~40 MB download on first use, cached by the browser after that.
- **Audio capture:** `getUserMedia` → `AudioContext` → `ScriptProcessorNode` (4096 frames). Resampled to 16 kHz before transcription.
- **Voice-activity segmenter:** RMS energy against an adaptive noise floor (`thr = max(0.012, noise*3)`). Keeps ~3 buffers of pre-roll. A segment is sent to Whisper after `PAUSE = 0.45` s of quiet or when it reaches 6 s. Segments under 0.4 s are dropped. Segments queue and are transcribed one at a time.
- **Matching:** Arabic text is normalized by `norm()` (strips diacritics/tatweel, unifies alef / ta marbuta / alef maqsura, removes spaces and non-Arabic). Built-in tasbeehs use regexes on the normalized text; matches are counted per segment.
- **Screen wake lock** is requested while listening, since iOS stops audio when the screen locks.
- **Voice-sample engine (no Whisper):** if the current tasbeeh has ≥3 recorded samples and "Count using my voice samples" is on, listening skips Whisper entirely (no model download). Audio is turned into 12 MFCCs (c0 dropped so volume/whispering don't matter) every 10 ms, and every sample is matched against the live stream with open-start subsequence DTW (SPRING). A count fires at the lowest score once it hasn't improved for 120 ms; paths that started before that end are cleared so one recitation counts once. Matches must be 0.5–2× the sample's length and ≥50% above the energy threshold. Back-to-back recitation without pauses works.
- **Threshold** is calibrated from the samples: 90th percentile of leave-one-out scores × 1.15, lowered if another tasbeeh's samples score too close (tasbeehs whose text contains the other, like SubhanAllah / ...wa bihamdihi, are not compared). The user's sensitivity slider (0.7–1.5×, `localStorage` `vsens`) multiplies it. The status line shows the match score and limit on every count, and near misses (within 1.5× of the limit), so the owner can report numbers.

## Features

- **Phrase library + categories.** `P` holds 26 phrases (Arabic with harakat, `tr` name, English meaning `en`, optional regex `re`). `CATS` lists categories with per-category targets: Everyday, After prayer (Astaghfirullah 3, Allahumma antas-salam, 33/33/34, Ayat al-Kursi), Morning and Evening (selection from Hisn al-Muslim: Ayat al-Kursi, 3 Quls ×3, Sayyid al-Istighfar, Raditu ×3, Bismillahilladhi ×3, 'Afini ×3, Hasbiyallahu ×7, 'adada khalqihi ×3 (morning) / A'udhu bi kalimatillah ×3 (evening), Tahlil wahdahu ×10, SubhanAllahi wa bihamdihi ×100, Astaghfirullaha wa atubu ilayh ×100), Friday (Salawat ×100, Sallallahu alayhi wa sallam ×100, Salawat Ibrahimiyya ×10, Astaghfirullah ×100), My tasbeehs (custom; tab hidden when empty). `T` is the flat list of entries (a phrase can appear in several categories with separate counts). Learned spellings and voice samples are keyed by `tr`, so they are shared across categories.
- Matching: phrases with `re` use the regex; others (and custom ones) use `fuzzy()`. Only the selected entry is ever counted, so overlapping phrases (SubhanAllah inside SubhanAllahi wa bihamdihi) don't matter. Phrases over 60 normalized letters (Ayat al-Kursi, Quls, Sayyid al-Istighfar, etc.) are tap-only; a hint says so. Long texts get a smaller font, capped at 40vh with scrolling.
- **Navigation: left panel.** A menu button (top-left) opens a slide-in panel (`#side`, `renderList()`) with collapsible category sections (header shows "N of M done"), each listing its tasbeehs with progress (`×target`, `count/target`, or ✓). Picking one closes the panel; closes also on scrim tap, ✕, Esc, or swiping left. The current category is expanded automatically. At ≥900px wide the panel stays open as a sidebar. Under the title, `#crumb` shows "Category · i of n".
- **Auto-advance** (checkbox, on by default): on reaching a target, moves to the next unfinished entry in the same category; "All done" at the end. Finished entries get a ✓ in the list.
- **Progress persists for the day** in `localStorage` key `progress` ({day, c: counts, n: edited targets}, keyed `cat|tr`). Counts reset on a new day; edited targets are kept. Selection is kept in `sel`. "Reset whole list" clears the current category.
- Progress-ring counter that also works by tapping; undo; reset; editable target per tasbeeh.
- Vibration on each count and on reaching the target (`navigator.vibrate` does nothing on iOS).
- **Custom tasbeehs:** name, Arabic phrase, target. "Use what it last heard" fills the phrase from the last transcript. Stored in `localStorage` key `customT`. Matched with `fuzzy()`: Levenshtein against sliding windows (length L, L−1, L+1), tolerance 20% of phrase length.
- **Learn from corrections:** after each transcript a row appears; the user sets how many they actually recited and taps "Count it & learn". The normalized transcript is divided by that count and the first slice is saved as an alias for the current tasbeeh (`localStorage` key `aliases`, keyed by tasbeeh name, max 20 each). Aliases are only checked when the built-in/custom match returns 0. "Forget learned spellings" clears them.
- "Test without speaking" box: type Arabic to test matching (Whisper path only).
- **Train it on my voice:** "Record samples" uses the pause segmenter; each phrase becomes one sample (trimmed, 0.25–4 s). Samples are stored as 16 kHz Int16 audio in IndexedDB (`tasbeeh` db, `samples` store, `{t: tasbeeh name, a, at}`) so a better model can retrain from them later. Play last / Delete last / Delete all. `navigator.storage.persist()` is requested. Deleting a custom tasbeeh deletes its samples. Enrollment and voice listening use a lower energy floor (0.006) than Whisper (0.012) to catch whispers.
- Tested in headless Chromium with espeak-ng Arabic fed in as a fake mic: 5/5 SubhanAllah counted, 0 false counts on Alhamdulillah, 4/4 back-to-back. Synthetic voices are very consistent, so real-voice thresholds will be looser.

## Known issues and limits

- Noticeable delay between reciting and the count moving: the pause wait plus Whisper inference time on the phone. Pause was cut from 0.7 s to 0.45 s; watch for phrases being split and double/under counted. If so, raise toward 0.55 s.
- Whispered or very fast, run-together recitation is often missed.
- Counting stops if the screen locks or the user switches apps (iOS limitation for web pages).
- `ScriptProcessorNode` is deprecated; an `AudioWorklet` would be cleaner.
- iOS can clear `localStorage` for home-screen web apps that go unused for a while.
- Nothing has been tested by Claude on a real iPhone; all verification has come from the owner.

## Ideas for next steps (owner hasn't chosen yet)

1. Measure how often learned aliases fix misses before building anything bigger.
2. Reduce latency: move inference to a Web Worker so the UI never stalls; try WebGPU where available.
3. Personal voice samples: **step 1 (recording) and step 2 (DTW template matching) are built.** If DTW isn't accurate enough on the owner's voice, step 3 is a small pretrained audio-embedding model plus a classifier trained in the browser on the stored samples. A further idea: save missed/false segments as extra positive/negative samples.
4. Session history (counts per day) stored locally. Today's counts already persist (`progress`); history would keep past days too.
5. ~~Add a web app manifest and icon~~ Done, with offline support. Existing home-screen installs must be removed and re-added to pick up the new icon.
