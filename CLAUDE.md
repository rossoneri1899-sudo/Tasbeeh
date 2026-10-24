# Hands-free Tasbeeh — project notes

A web app that counts tasbeeh (Islamic phrases of remembrance) by listening to the user recite, instead of tapping. Everything lives in a single file, `index.html`, hosted on GitHub Pages and used on an iPhone in Safari (added to the home screen).

## Constraints (read first)

- **The owner uses an iPhone and has no Mac.** A native iOS app is off the table for now. Everything must work as a web page in iOS Safari.
- **Hosted on GitHub Pages** from the `main` branch root. Deploying = committing `index.html` to `main`.
- **On-device only.** No audio may leave the phone. Do not add server-side speech APIs.
- **Do not use the Web Speech API** (`SpeechRecognition` / `webkitSpeechRecognition`). It is unavailable or blocked on iPhone; this was the first approach and it failed.
- **Single self-contained file.** Keep markup, styles and script in `index.html`. External scripts only from a CDN.
- The owner tests on their phone and reports back. There is no automated test setup, so keep changes small and easy to verify by hand. After each deploy, remind them to reload with a new `?v=N` query string, because Safari caches the old page.

## How it works now

- **Speech engine:** Whisper tiny (`Xenova/whisper-tiny`, q8) running in the page via transformers.js (`@huggingface/transformers@3.5.1` from jsDelivr). ~40 MB download on first use, cached by the browser after that.
- **Audio capture:** `getUserMedia` → `AudioContext` → `ScriptProcessorNode` (4096 frames). Resampled to 16 kHz before transcription.
- **Voice-activity segmenter:** RMS energy against an adaptive noise floor (`thr = max(0.012, noise*3)`). Keeps ~3 buffers of pre-roll. A segment is sent to Whisper after `PAUSE = 0.45` s of quiet or when it reaches 6 s. Segments under 0.4 s are dropped. Segments queue and are transcribed one at a time.
- **Matching:** Arabic text is normalized by `norm()` (strips diacritics/tatweel, unifies alef / ta marbuta / alef maqsura, removes spaces and non-Arabic). Built-in tasbeehs use regexes on the normalized text; matches are counted per segment.
- **Screen wake lock** is requested while listening, since iOS stops audio when the screen locks.
- **Voice-sample engine (no Whisper):** if the current tasbeeh has ≥3 recorded samples and "Count using my voice samples" is on, listening skips Whisper entirely (no model download). Audio is turned into 12 MFCCs (c0 dropped so volume/whispering don't matter) every 10 ms, and every sample is matched against the live stream with open-start subsequence DTW (SPRING). A count fires at the lowest score once it hasn't improved for 120 ms; paths that started before that end are cleared so one recitation counts once. Matches must be 0.5–2× the sample's length and ≥50% above the energy threshold. Back-to-back recitation without pauses works.
- **Threshold** is calibrated from the samples: 90th percentile of leave-one-out scores × 1.15, lowered if another tasbeeh's samples score too close (tasbeehs whose text contains the other, like SubhanAllah / ...wa bihamdihi, are not compared). The user's sensitivity slider (0.7–1.5×, `localStorage` `vsens`) multiplies it. The status line shows the match score and limit on every count, and near misses (within 1.5× of the limit), so the owner can report numbers.

## Features

- 8 built-in tasbeehs: SubhanAllah (33), Alhamdulillah (33), Allahu Akbar (34), La ilaha illallah, Astaghfirullah, SubhanAllahi wa bihamdihi, La hawla wa la quwwata illa billah, Salawat (100 each). The SubhanAllah regex excludes "wa bihamdihi" so the two don't double count.
- Progress-ring counter that also works by tapping; undo; reset; editable target per tasbeeh.
- After-prayer set toggle: 33 / 33 / 34 with auto-advance.
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
4. Session history (counts per day) stored locally.
5. Add a web app manifest and icon so the home-screen version looks and behaves more like an app.
