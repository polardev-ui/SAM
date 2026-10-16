# I-AM-SAM

Two legendary robot voices in one Next.js app, switchable from the pill in the
top right. No sign-ups.

- **Classic SAM** — the 1982 Software Automatic Mouth (C64), via
  [`sam-js`](https://www.npmjs.com/package/sam-js) (22050 Hz 8-bit mono WAV).
  Runs 100% in your browser.
- **Microsoft SAM** — the actual 1998 SAPI4 Sam, rendered by the genuine engine
  through a bundled `/api/sapi4` proxy that returns real 22050 Hz 16-bit WAV
  audio. Not a system-voice imitation.

Type text, pick a preset (Classic only), fine-tune pitch / speed
(+ throat / mouth on Classic), preview in-browser, and save as `.wav`.

## Run

```bash
npm install
npm run dev
# open http://localhost:3000
```

```bash
npm run build
npm run start
```

## Notes

- `sam-js` captures voice options at construction time, so the app builds a fresh `new SamJs({ pitch, speed, throat, mouth })` per render. Mutating `sam.pitch` after construction has no effect.
- `Speak` renders via `buf32` + Web Audio and also caches a WAV blob for the inline player. `Save WAV` renders via `wav()` and downloads `i-am-sam-<text>.wav` locally.
- Pitch slider is limited to 30–210. Outside that window SAM's 8-bit period register wraps into dead frames (effective per-frame pitch ≤ 0, verified by instrumenting the engine), so 0 and 255 collapse into the same harsh buzz. All factory presets fit inside the window.
- Microsoft mode maps the shared sliders onto Sam's native SAPI4 ranges (pitch 50–200, speed 30–450, axes flipped so higher still means deeper/slower) and holds text to 300 chars (upstream limit).
- Shortcut: `Cmd/Ctrl + Enter` to speak.
