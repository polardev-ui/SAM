"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type PresetKey = "sam" | "elf" | "robot" | "stuffy" | "oldlady" | "et" | "deep" | "custom";

type Engine = "classic" | "microsoft";

const PRESETS: Record<
  Exclude<PresetKey, "custom">,
  { label: string; description: string; speed: number; pitch: number; throat: number; mouth: number }
> = {
  sam: {
    label: "SAM",
    description: "Default 1982 voice",
    speed: 72,
    pitch: 64,
    throat: 128,
    mouth: 128,
  },
  elf: { label: "Elf", description: "Bright & thin", speed: 72, pitch: 64, throat: 110, mouth: 160 },
  robot: { label: "Robot", description: "Metallic", speed: 92, pitch: 60, throat: 190, mouth: 190 },
  stuffy: { label: "Stuffy", description: "Nasal", speed: 82, pitch: 72, throat: 110, mouth: 105 },
  oldlady: { label: "Old Lady", description: "Low & soft", speed: 82, pitch: 32, throat: 145, mouth: 145 },
  et: { label: "E.T.", description: "Otherworldly", speed: 100, pitch: 64, throat: 150, mouth: 200 },
  deep: { label: "Deep", description: "Low & slow", speed: 80, pitch: 96, throat: 120, mouth: 120 },
};

const SAMPLE_RATE = 22050;
const MAX_CHARS = 1000;
// Raw SAM pitch is only monotonic in this window. Verified by instrumenting
// the engine's effective per-frame pitch track ((pitch + stress) & 0xFF - F1/2):
// below ~30 and above ~210 frames go dead (effective pitch <= 0, the glottal
// reset never fires) and extremes wrap back to sounding like each other.
// All factory presets (lowest: Old Lady 32) fit inside this window.
const PITCH_MIN = 30;
const PITCH_MAX = 210;
const DEFAULT_TEXT = "Hello! I am the Software Automatic Mouth.";

function findMatchingPreset(pitch: number, speed: number, throat: number, mouth: number): PresetKey {
  for (const [key, p] of Object.entries(PRESETS)) {
    if (p.pitch === pitch && p.speed === speed && p.throat === throat && p.mouth === mouth) {
      return key as PresetKey;
    }
  }
  return "custom";
}

// Short fingerprint of rendered bytes so two renders can be told apart
// by eye (proves the params actually reached the engine).
function fingerprint(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(bytes.length / 4096));
  for (let i = 0; i < bytes.length; i += step) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// Microsoft Sam's stock voice: SAPI pitch 118, speed 163. Expressed in our
// shared slider units (inverted through toSapiPitch/toSapiSpeed) so the first
// render lands exactly on P118 S163.
const MS_DEFAULT_PITCH = 128;
const MS_DEFAULT_SPEED = 174;

// SAPI4 mapping for Microsoft mode. Our sliders keep Classic SAM semantics in
// both engines (higher pitch value = deeper voice, higher speed value = slower
// speech). SAPI4 is conventional (higher pitch = higher voice, higher speed =
// faster speech), so both axes are flipped here. Sam's real limits are
// pitch 50-200 and speed 30-450.
const SAPI_PITCH_LO = 50;
const SAPI_PITCH_HI = 200;
const SAPI_SPEED_LO = 30;
const SAPI_SPEED_HI = 450;

function toSapiPitch(ui: number): number {
  const t = Math.min(PITCH_MAX, Math.max(PITCH_MIN, ui));
  return Math.round(SAPI_PITCH_HI - ((t - PITCH_MIN) / (PITCH_MAX - PITCH_MIN)) * (SAPI_PITCH_HI - SAPI_PITCH_LO));
}

function toSapiSpeed(ui: number): number {
  const t = Math.min(255, Math.max(0, ui));
  return Math.round(SAPI_SPEED_HI - (t / 255) * (SAPI_SPEED_HI - SAPI_SPEED_LO));
}

export default function Home() {
  const [text, setText] = useState(DEFAULT_TEXT);
  const [preset, setPreset] = useState<PresetKey>("sam");
  const [pitch, setPitch] = useState(64);
  const [speed, setSpeed] = useState(72);
  const [throat, setThroat] = useState(128);
  const [mouth, setMouth] = useState(128);
  const [phonetic, setPhonetic] = useState(false);

  const [isBusy, setIsBusy] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [engine, setEngine] = useState<Engine>("classic");
  const [msAutoplay, setMsAutoplay] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [renderHash, setRenderHash] = useState<string | null>(null);
  const [renderParams, setRenderParams] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const msAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    audioUrlRef.current = audioUrl;
  }, [audioUrl]);

  /* eslint-disable react-hooks/set-state-in-effect -- mount-once restore of persisted prefs, no loop */
  useEffect(() => {
    try {
      if (localStorage.getItem("i-am-sam-engine") === "microsoft") {
        setEngine("microsoft");
        setPitch(MS_DEFAULT_PITCH);
        setSpeed(MS_DEFAULT_SPEED);
      }
    } catch {}
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Autoplay the freshly rendered Microsoft clip in the visible player.
  useEffect(() => {
    if (engine === "microsoft" && msAutoplay && audioUrl && msAudioRef.current) {
      setMsAutoplay(false);
      try {
        msAudioRef.current.load();
      } catch {}
      void msAudioRef.current.play().catch(() => {});
    }
  }, [engine, msAutoplay, audioUrl]);

  useEffect(() => {
    const msAudio = msAudioRef.current;
    return () => {
      try {
        sourceRef.current?.stop();
      } catch {}
      try {
        ctxRef.current?.close();
      } catch {}
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      try {
        msAudio?.pause();
      } catch {}
    };
  }, []);

  const stopPlayback = useCallback(() => {
    try {
      sourceRef.current?.stop();
    } catch {}
    sourceRef.current = null;
    try {
      msAudioRef.current?.pause();
    } catch {}
    setIsPlaying(false);
  }, []);

  const switchEngine = useCallback(
    (next: Engine) => {
      if (next === engine) return;
      try {
        sourceRef.current?.stop();
      } catch {}
      sourceRef.current = null;
      try {
        msAudioRef.current?.pause();
      } catch {}
      setIsPlaying(false);
      setEngine(next);
      if (next === "microsoft") {
        // Stock Sam voice: these slider positions map to SAPI P118 S163.
        setPitch(MS_DEFAULT_PITCH);
        setSpeed(MS_DEFAULT_SPEED);
      } else {
        // Stock Classic SAM voice.
        setPitch(64);
        setSpeed(72);
        setThroat(128);
        setMouth(128);
        setPreset("sam");
      }
      try {
        localStorage.setItem("i-am-sam-engine", next);
      } catch {}
    },
    [engine]
  );

  // Render via the real SAPI4 engine through /api/sapi4. Returns the raw WAV
  // bytes plus the native pitch/speed actually used, or null on failure.
  const fetchSapiAudio = useCallback(async () => {
    const trimmed = text.trim().slice(0, 300);
    if (!trimmed) {
      setError("Type something for SAM to say first.");
      return null;
    }
    const sapiPitch = toSapiPitch(pitch);
    const sapiSpeed = toSapiSpeed(speed);
    const params = new URLSearchParams({
      text: trimmed,
      pitch: String(sapiPitch),
      speed: String(sapiSpeed),
    });
    const res = await fetch(`/api/sapi4?${params.toString()}`);
    if (!res.ok) {
      let msg = "SAPI4 engine error";
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) msg = body.error;
      } catch {}
      throw new Error(msg);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length < 100) throw new Error("Empty audio from SAPI4 engine");
    return { bytes, trimmed, sapiPitch, sapiSpeed };
  }, [text, pitch, speed]);

  const cacheSapiBlob = useCallback((bytes: Uint8Array, label: string) => {
    const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = url;
    setAudioUrl(url);
    setRenderHash(fingerprint(bytes));
    setRenderParams(label);
  }, []);

  const renderMicrosoft = useCallback(
    async (mode: "playback" | "file") => {
      setError(null);
      setIsBusy(true);
      try {
        const out = await fetchSapiAudio();
        if (!out) return null;
        const label = `MS · Sam · P${out.sapiPitch} S${out.sapiSpeed}`;
        cacheSapiBlob(out.bytes, label);
        // Duration from the WAV data chunk (44-byte header, 16-bit mono).
        setDuration(Math.max(0, (out.bytes.length - 44) / 2 / 22050));
        if (mode === "playback") {
          setMsAutoplay(true);
        } else {
          const a = document.createElement("a");
          const slug =
            out.trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24) || "sam";
          a.href = audioUrlRef.current ?? "";
          a.download = `i-am-sam-ms-${slug}.wav`;
          document.body.appendChild(a);
          a.click();
          a.remove();
        }
        return true;
      } catch (e) {
        console.error(e);
        setError(e instanceof Error ? e.message : "Something went wrong with the SAPI4 engine.");
        return null;
      } finally {
        setIsBusy(false);
      }
    },
    [fetchSapiAudio, cacheSapiBlob]
  );

  const applyPreset = useCallback((key: Exclude<PresetKey, "custom">) => {
    const p = PRESETS[key];
    setPreset(key);
    setPitch(p.pitch);
    setSpeed(p.speed);
    setThroat(p.throat);
    setMouth(p.mouth);
  }, []);

  const updateParam = useCallback(
    (name: "pitch" | "speed" | "throat" | "mouth", value: number) => {
      const next = { pitch, speed, throat, mouth, [name]: value };
      if (name === "pitch") setPitch(value);
      if (name === "speed") setSpeed(value);
      if (name === "throat") setThroat(value);
      if (name === "mouth") setMouth(value);
      setPreset(findMatchingPreset(next.pitch, next.speed, next.throat, next.mouth));
    },
    [pitch, speed, throat, mouth]
  );

  // NOTE: sam-js captures voice options at construction time.
  // Mutating sam.pitch / sam.speed after `new SamJs()` has no effect,
  // so we always build a fresh instance per render.
  // NOTE: SAM's raw registers are inverted vs. intuition:
  // higher Pitch value = deeper voice, higher Speed value = slower speech.
  // Speed 0 is falsy in the engine and silently falls back to 72,
  // so clamp it to 1 (fastest) to keep the slider honest.
  // Pitch is clamped to PITCH_MIN..PITCH_MAX in the UI: outside that range
  // the 8-bit period register wraps (dead frames with effective pitch <= 0),
  // so 0 and 255 both collapse into the same harsh buzz.
  const renderSam = useCallback(
    async (mode: "playback" | "file") => {
      const trimmed = text.trim();
      if (!trimmed) {
        setError("Type something for SAM to say first.");
        return null;
      }
      setError(null);
      setIsBusy(true);
      try {
        const mod = await import("sam-js");
        type SamInstance = {
          buf32: (text: string, phonetic?: boolean) => Float32Array | false | unknown;
          wav: (text: string, phonetic?: boolean) => Uint8Array | false | unknown;
        };
        type SamCtor = new (opts: {
          pitch: number;
          speed: number;
          throat: number;
          mouth: number;
        }) => SamInstance;
        const SamJs = (
          (mod as unknown as { default?: SamCtor }).default ?? (mod as unknown as SamCtor)
        );
        const sam = new SamJs({ pitch, speed: Math.max(1, speed), throat, mouth });
        const patchLabel = `P${pitch} S${Math.max(1, speed)} T${throat} M${mouth}${phonetic ? " · phon" : ""}`;

        if (mode === "playback") {
          stopPlayback();
          const buf = sam.buf32(trimmed, phonetic);
          if (!buf || buf === false) throw new Error("SAM could not render that text.");
          const samples = buf as Float32Array;

          const wavBytes = sam.wav(trimmed, phonetic);
          if (wavBytes && wavBytes !== false) {
            const bytes = (wavBytes as Uint8Array).slice();
            const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "audio/wav" });
            const url = URL.createObjectURL(blob);
            if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
            audioUrlRef.current = url;
            setAudioUrl(url);
            setDuration(samples.length / SAMPLE_RATE);
            setRenderHash(fingerprint(bytes));
            setRenderParams(patchLabel);
          }

          if (!ctxRef.current) {
            ctxRef.current = new AudioContext({ sampleRate: SAMPLE_RATE });
          }
          const ctx = ctxRef.current;
          if (ctx.state === "suspended") await ctx.resume();

          const audioBuffer = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
          audioBuffer.getChannelData(0).set(samples);
          const src = ctx.createBufferSource();
          src.buffer = audioBuffer;
          src.connect(ctx.destination);
          sourceRef.current = src;
          setIsPlaying(true);
          src.onended = () => {
            if (sourceRef.current === src) {
              sourceRef.current = null;
              setIsPlaying(false);
            }
          };
          src.start();
          return true;
        } else {
          const wavBytes = sam.wav(trimmed, phonetic);
          if (!wavBytes || wavBytes === false) throw new Error("SAM could not render that text.");
          const bytes = (wavBytes as Uint8Array).slice();
          const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "audio/wav" });
          const url = URL.createObjectURL(blob);
          if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
          audioUrlRef.current = url;
          setAudioUrl(url);
          setRenderHash(fingerprint(bytes));
          setRenderParams(patchLabel);

          // Derive duration from the WAV data chunk (header is 44 bytes, 8-bit mono).
          setDuration(Math.max(0, (bytes.length - 44) / SAMPLE_RATE));

          const a = document.createElement("a");
          const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24) || "sam";
          a.href = url;
          a.download = `i-am-sam-${slug}.wav`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          return true;
        }
      } catch (e) {
        console.error(e);
        setError(e instanceof Error ? e.message : "Something went wrong rendering audio.");
        return null;
      } finally {
        setIsBusy(false);
      }
    },
    [text, pitch, speed, throat, mouth, phonetic, stopPlayback]
  );

  const handleSpeak = useCallback(() => {
    if (engine === "microsoft") {
      void renderMicrosoft("playback");
    } else {
      void renderSam("playback");
    }
  }, [renderSam, renderMicrosoft, engine]);

  const handleDownload = useCallback(() => {
    if (engine === "microsoft") {
      void renderMicrosoft("file");
    } else {
      void renderSam("file");
    }
  }, [renderSam, renderMicrosoft, engine]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleSpeak();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleSpeak]);

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <div className="mx-auto max-w-2xl px-4 pb-16 pt-6 sm:pt-10">
        <div className="flex justify-center sm:justify-end">
          <div
            role="tablist"
            aria-label="Speech engine"
            className="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white p-1 shadow-sm"
          >
            {(
              [
                { key: "classic", label: "Classic SAM" },
                { key: "microsoft", label: "Microsoft SAM" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.key}
                role="tab"
                aria-selected={engine === opt.key}
                type="button"
                onClick={() => switchEngine(opt.key)}
                className={`rounded-full px-4 py-1.5 text-xs font-semibold transition ${
                  engine === opt.key
                    ? "bg-neutral-900 text-white"
                    : "text-neutral-500 hover:text-neutral-900"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <header className="text-center">
          <p className="inline-flex items-center gap-2 rounded-full border border-neutral-200 bg-white px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-neutral-500">
            <span className="h-1.5 w-1.5 rounded-full bg-neutral-900" />
            1982 · Software Automatic Mouth
          </p>
          <h1 className="mt-4 text-4xl font-bold tracking-tight sm:text-5xl">I-AM-SAM</h1>
          <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-neutral-500">
            {engine === "classic"
              ? "Type anything, tune the voice, press speak. Runs entirely in your browser — no sign-up, no uploads. Save the result as a WAV file."
              : "The actual 1998 SAPI4 Sam, rendered by the real engine and streamed back as genuine WAV audio. No sign-up — just quick."}
          </p>
        </header>

        <main className="mt-8 rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm sm:p-7">
          <div className="flex items-baseline justify-between gap-3">
            <label htmlFor="sam-text" className="text-sm font-semibold">
              Text to speak
            </label>
            <span className="text-xs tabular-nums text-neutral-400">
              {text.length}/{engine === "microsoft" ? 300 : MAX_CHARS}
            </span>
          </div>
          <textarea
            id="sam-text"
            rows={4}
            maxLength={engine === "microsoft" ? 300 : MAX_CHARS}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Hello! I am the Software Automatic Mouth."
            className="mt-2 w-full resize-y rounded-xl border border-neutral-200 bg-neutral-50 p-3 text-sm leading-relaxed outline-none transition placeholder:text-neutral-400 focus:border-neutral-900 focus:bg-white focus:ring-2 focus:ring-neutral-900/10"
          />

          {engine === "classic" && (
            <>
              <div className="mt-5 flex items-center justify-between gap-3">
                <span className="text-sm font-semibold">Voice preset</span>
                {preset === "custom" && (
                  <span className="rounded-full bg-neutral-900 px-2.5 py-0.5 text-[11px] font-medium text-white">
                    Custom
                  </span>
                )}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {(Object.keys(PRESETS) as Array<Exclude<PresetKey, "custom">>).map((key) => {
                  const active = preset === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => applyPreset(key)}
                      title={PRESETS[key].description}
                      className={`rounded-xl border px-3 py-2.5 text-left transition ${
                        active
                          ? "border-neutral-900 bg-neutral-900 text-white"
                          : "border-neutral-200 bg-white text-neutral-900 hover:border-neutral-400"
                      }`}
                    >
                      <span className="block text-sm font-semibold leading-none">
                        {PRESETS[key].label}
                      </span>
                      <span
                        className={`mt-1 block text-[11px] leading-none ${
                          active ? "text-neutral-300" : "text-neutral-400"
                        }`}
                      >
                        {PRESETS[key].description}
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {engine === "microsoft" && (
            <div className="mt-5 rounded-xl border border-neutral-200 bg-neutral-50 p-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-semibold">Voice</span>
                <span className="font-mono text-xs tabular-nums text-neutral-500">
                  Sam · real SAPI4
                </span>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-neutral-400">
                Not a system-voice imitation — audio is rendered by the genuine 1998
                SAPI4 engine. Stock Sam is pitch 118 / speed 163, which is where the
                sliders start. Microsoft mode holds text to 300 characters.
              </p>
            </div>
          )}

          <div className="mt-6 space-y-5">
            <Slider
              label="Pitch"
              value={pitch}
              min={PITCH_MIN}
              max={PITCH_MAX}
              hint="Higher = deeper"
              lowLabel={`shrill · ${PITCH_MIN}`}
              highLabel={`${PITCH_MAX} · deep`}
              onChange={(v) => updateParam("pitch", v)}
            />
            <Slider
              label="Speed"
              value={speed}
              hint="Higher = slower"
              lowLabel="faster"
              highLabel="slower"
              onChange={(v) => updateParam("speed", v)}
            />
            {engine === "classic" ? (
              <>
                <Slider
                  label="Throat"
                  value={throat}
                  onChange={(v) => updateParam("throat", v)}
                />
                <Slider
                  label="Mouth"
                  value={mouth}
                  onChange={(v) => updateParam("mouth", v)}
                />
              </>
            ) : (
              <p className="rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-xs leading-relaxed text-neutral-500">
                Throat &amp; mouth are Classic SAM registers — SAPI4 Sam voices them
                through its own pitch &amp; speed only.
              </p>
            )}
          </div>

          {engine === "classic" && (
            <label className="mt-6 flex cursor-pointer items-start gap-2.5 text-sm text-neutral-600">
              <input
                type="checkbox"
                checked={phonetic}
                onChange={(e) => setPhonetic(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-neutral-900"
              />
              <span>
                Phonetic input
                <span className="block text-xs text-neutral-400">
                  Skip the English-to-phoneme step and send text straight to SAM.
                </span>
              </span>
            </label>
          )}

          {error && (
            <p className="mt-4 rounded-xl border border-neutral-900/15 bg-neutral-100 px-3 py-2.5 text-sm text-neutral-800">
              {error}
            </p>
          )}

          <div className="mt-6 flex flex-col gap-2 sm:flex-row">
            {!isPlaying ? (
              <button
                type="button"
                onClick={handleSpeak}
                disabled={isBusy || !text.trim()}
                className="flex-1 rounded-xl bg-neutral-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isBusy ? "Rendering…" : "Speak  ⌘⏎"}
              </button>
            ) : (
              <button
                type="button"
                onClick={stopPlayback}
                className="flex-1 rounded-xl bg-neutral-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-neutral-700"
              >
                Stop
              </button>
            )}
            <button
              type="button"
              onClick={handleDownload}
              disabled={isBusy || !text.trim()}
              className="flex-1 rounded-xl border border-neutral-900 px-4 py-3 text-sm font-semibold transition hover:bg-neutral-900 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isBusy ? "Rendering…" : "Save WAV"}
            </button>
          </div>

          {engine === "classic" && audioUrl && (
            <div className="mt-5 rounded-xl border border-neutral-200 bg-neutral-50 p-3">
              <div className="flex items-center justify-between gap-2 px-1 pb-2">
                <span className="text-xs font-medium uppercase tracking-wider text-neutral-400">
                  Last render
                </span>
                {duration !== null && (
                  <span className="text-xs tabular-nums text-neutral-500">
                    {duration.toFixed(2)}s · 22050 Hz · 8-bit mono WAV
                  </span>
                )}
              </div>
              {renderParams && (
                <p className="px-1 pb-2 font-mono text-[11px] tabular-nums text-neutral-400">
                  {renderParams}
                  {renderHash ? ` · #${renderHash}` : ""}
                </p>
              )}
              <audio key={audioUrl} controls src={audioUrl} className="w-full" />
            </div>
          )}

          {engine === "microsoft" && renderParams && audioUrl && (
            <div className="mt-5 rounded-xl border border-neutral-200 bg-neutral-50 p-3">
              <div className="flex items-center justify-between gap-2 px-1 pb-2">
                <span className="text-xs font-medium uppercase tracking-wider text-neutral-400">
                  Last spoken
                </span>
                {duration !== null && (
                  <span className="text-xs tabular-nums text-neutral-500">
                    {duration.toFixed(2)}s · genuine SAPI4 WAV
                  </span>
                )}
              </div>
              <p className="px-1 pb-2 font-mono text-[11px] tabular-nums text-neutral-400">
                {renderParams}
                {renderHash ? ` · #${renderHash}` : ""}
              </p>
              <audio
                ref={msAudioRef}
                controls
                src={audioUrl}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onEnded={() => setIsPlaying(false)}
                className="w-full"
              />
            </div>
          )}
        </main>

        <section className="mt-4 grid gap-4 sm:grid-cols-3">
          {[
            { title: "1. Type", body: "Plain English works. Try ALL CAPS for extra bark." },
            { title: "2. Tune", body: "Presets set all four knobs. Pitch: higher = deeper. Speed: higher = slower." },
            { title: "3. Save", body: "Speak previews it. Save WAV downloads it locally." },
          ].map((s) => (
            <div
              key={s.title}
              className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm"
            >
              <p className="text-sm font-semibold">{s.title}</p>
              <p className="mt-1 text-[13px] leading-relaxed text-neutral-500">{s.body}</p>
            </div>
          ))}
        </section>

        <footer className="mt-8 text-center text-xs text-neutral-400">
          {engine === "classic"
            ? "A tiny tribute to S.A.M. (1982). Synthesis happens on-device via sam-js — nothing leaves your browser."
            : "The real Microsoft Sam (1998 SAPI4) — audio rendered by the genuine engine."}
        </footer>
      </div>
    </div>
  );
}

function Slider({
  label,
  value,
  onChange,
  hint,
  min = 0,
  max = 255,
  lowLabel = "0",
  highLabel = "255",
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  hint?: string;
  min?: number;
  max?: number;
  lowLabel?: string;
  highLabel?: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label className="text-sm font-medium text-neutral-700">
          {label}
          {hint && <span className="ml-2 text-xs font-normal text-neutral-400">{hint}</span>}
        </label>
        <span className="rounded-md bg-neutral-100 px-2 py-0.5 font-mono text-xs tabular-nums text-neutral-700">
          {value}
        </span>
      </div>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        value={Math.min(max, Math.max(min, value))}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        className="mt-2 w-full"
      />
      <div className="flex justify-between text-[10px] tabular-nums text-neutral-400">
        <span>{lowLabel}</span>
        <span>{highLabel}</span>
      </div>
    </div>
  );
}
