// Proxy to the real Microsoft SAPI4 (1998) synthesis engine.
// The browser can't run SAPI4 natively, so we forward the request upstream
// and return the authentic WAV bytes. No signup, no key.
const UPSTREAM = "https://www.tetyys.com/SAPI4/SAPI4";

const MIN_PITCH = 50;
const MAX_PITCH = 200;
const DEF_PITCH = 100;
const MIN_SPEED = 30;
const MAX_SPEED = 450;
const DEF_SPEED = 150;
const MAX_TEXT = 300;

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  const n = parseInt(raw ?? "", 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const text = (searchParams.get("text") ?? "").trim().slice(0, MAX_TEXT);
  if (!text) {
    return Response.json({ error: "Missing text" }, { status: 400 });
  }
  const pitch = clampInt(searchParams.get("pitch"), MIN_PITCH, MAX_PITCH, DEF_PITCH);
  const speed = clampInt(searchParams.get("speed"), MIN_SPEED, MAX_SPEED, DEF_SPEED);

  const url =
    `${UPSTREAM}?text=${encodeURIComponent(text)}` +
    `&voice=Sam&pitch=${pitch}&speed=${speed}`;

  let upstream: Response;
  try {
    upstream = await fetch(url, { signal: AbortSignal.timeout(30000) });
  } catch {
    return Response.json({ error: "SAPI4 engine unreachable" }, { status: 502 });
  }
  if (!upstream.ok) {
    const msg =
      (await upstream.text().catch(() => "")).slice(0, 200) || "SAPI4 engine error";
    return Response.json({ error: msg }, { status: 502 });
  }
  const buf = await upstream.arrayBuffer();
  if (!buf.byteLength || buf.byteLength < 100) {
    return Response.json({ error: "Empty audio from SAPI4 engine" }, { status: 502 });
  }
  return new Response(buf, {
    headers: {
      "Content-Type": "audio/wav",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
