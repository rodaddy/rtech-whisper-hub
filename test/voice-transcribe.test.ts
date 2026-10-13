import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test } from "node:test";
import pino from "pino";
import {
  type Clock,
  InFlight,
  ROUTE_LIMITS,
  Semaphore,
  TokenBucket,
} from "../src/voice/limits.ts";
import { transcribeRoutes } from "../src/voice/transcribeRoute.ts";
import { makePcmWav, parseWav } from "../src/voice/wav.ts";

const RATE = 16000;
const PATH = "/voice/v1/audio/transcriptions";
const UPSTREAM = "http://upstream.test";

class FakeClock implements Clock {
  t = 1_000_000;
  now(): number {
    return this.t;
  }
  setTimer(): () => void {
    return () => {};
  }
}

// Speech-like: each second is 800 ms of tone then 200 ms of silence, so the
// adaptive trim sees a quiet noise floor and keeps every sample.
const tone = (seconds: number) => {
  const pcm = new Int16Array(seconds * RATE);
  for (let i = 0; i < pcm.length; i += 1) {
    if (i % RATE >= 0.8 * RATE) continue;
    pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / RATE));
  }
  return pcm;
};
const silence = (seconds: number) => new Int16Array(seconds * RATE);
const concat = (...parts: Int16Array[]) => {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

interface UpstreamCall {
  url: string;
  auth: string | null;
  fields: Record<string, string>;
  samples: number;
}

type Reply = (call: UpstreamCall) => Response | Promise<Response>;

function setup(opts: { reply?: Reply; apiKey?: string } = {}) {
  const calls: UpstreamCall[] = [];
  const lines: string[] = [];
  const clock = new FakeClock();
  const reply: Reply =
    opts.reply ?? (() => Response.json({ text: "hello world." }));
  const fakeFetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const form = init!.body as FormData;
    const fields: Record<string, string> = {};
    let samples = -1;
    for (const [k, v] of form.entries()) {
      if (typeof v === "string") fields[k] = v;
      else {
        const parsed = parseWav(new Uint8Array(await v.arrayBuffer()));
        assert.ok(parsed.ok);
        samples = parsed.wav.pcm.length;
      }
    }
    const call = {
      url: String(input),
      auth: new Headers(init!.headers).get("authorization"),
      fields,
      samples,
    };
    calls.push(call);
    return reply(call);
  }) as typeof fetch;
  const app = transcribeRoutes({
    config: {
      VOICE_UPSTREAM_URL: UPSTREAM,
      VOICE_UPSTREAM_API_KEY: opts.apiKey,
      VOICE_STT_MODEL: "whisper-large-v3-turbo",
    },
    logger: pino(
      { level: "info" },
      new Writable({
        write(chunk, _enc, cb) {
          lines.push(...String(chunk).split("\n").filter(Boolean));
          cb();
        },
      }),
    ),
    fetch: fakeFetch,
    clock,
    limiters: {
      bucket: new TokenBucket({
        capacity: ROUTE_LIMITS.transcription.burst,
        perMinute: ROUTE_LIMITS.transcription.perMinute,
        clock,
      }),
      inFlight: new InFlight(ROUTE_LIMITS.transcription.inFlight),
      semaphore: new Semaphore({ max: 4, maxWaitMs: 10_000, clock }),
    },
    getDeviceId: () => "device-1",
  });
  return { app, calls, lines };
}

function post(
  app: ReturnType<typeof setup>["app"],
  wav: Uint8Array,
  fields: Record<string, string> = {},
  headers: Record<string, string> = {},
) {
  const form = new FormData();
  form.set(
    "file",
    new Blob([wav as Uint8Array<ArrayBuffer>], { type: "audio/wav" }),
    "a.wav",
  );
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return app.request(PATH, {
    method: "POST",
    body: form,
    headers,
  });
}

test("happy path returns merged text and audio headers", async () => {
  const { app, calls } = setup({ apiKey: "upstream-secret" });
  const res = await post(app, makePcmWav(tone(2), RATE), {
    model: "whisper-large-v3-turbo",
    language: "en",
    prompt: "names: Rico",
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { text: "hello world." });
  assert.equal(res.headers.get("x-rtech-audio-original-ms"), "2000");
  assert.equal(res.headers.get("x-rtech-audio-kept-ms"), "2000");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${UPSTREAM}/v1/audio/transcriptions`);
  assert.equal(calls[0].auth, "Bearer upstream-secret");
  assert.equal(calls[0].fields.model, "whisper-large-v3-turbo");
  assert.equal(calls[0].fields.language, "en");
  assert.equal(calls[0].fields.prompt, "names: Rico");
});

test("no upstream key means no Authorization header upstream", async () => {
  const { app, calls } = setup();
  const res = await post(
    app,
    makePcmWav(tone(1), RATE),
    {},
    {
      authorization: "Bearer client-device-key",
    },
  );
  assert.equal(res.status, 200);
  assert.equal(calls[0].auth, null);
});

test("60 s of speech makes 3 upstream calls and merges overlaps", async () => {
  const replies = [
    "one two three four five",
    "three four five six seven",
    "five six seven eight",
  ];
  let i = 0;
  const { app, calls } = setup({
    reply: () => Response.json({ text: replies[i++] }),
  });
  const res = await post(app, makePcmWav(tone(60), RATE));
  assert.equal(res.status, 200);
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((c) => c.samples),
    [25 * RATE, 25 * RATE, 12 * RATE],
  );
  assert.deepEqual(await res.json(), {
    text: "one two three four five six seven eight",
  });
});

test("pure silence gives empty text and no upstream call", async () => {
  const { app, calls } = setup();
  const res = await post(app, makePcmWav(silence(3), RATE));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { text: "" });
  assert.equal(res.headers.get("x-rtech-no-speech"), "1");
  assert.equal(calls.length, 0);
});

test("a stereo WAV is 415", async () => {
  const { app, calls } = setup();
  const wav = makePcmWav(tone(1), RATE);
  new DataView(wav.buffer).setUint16(22, 2, true);
  const res = await post(app, wav);
  assert.equal(res.status, 415);
  assert.equal((await res.json()).code, "unsupported_audio_format");
  assert.equal(calls.length, 0);
});

test("a wrong model is 400 model_not_allowed", async () => {
  const { app, calls } = setup();
  const res = await post(app, makePcmWav(tone(1), RATE), {
    model: "whisper-1",
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "model_not_allowed");
  assert.equal(calls.length, 0);
});

test("x-rtech-client-trimmed: 1 skips the trim", async () => {
  const audio = concat(silence(3), tone(2), silence(3));
  const trimmed = setup();
  await post(trimmed.app, makePcmWav(audio, RATE));
  assert.ok(trimmed.calls[0].samples < audio.length);

  const { app, calls } = setup();
  const res = await post(
    app,
    makePcmWav(audio, RATE),
    {},
    {
      "x-rtech-client-trimmed": "1",
    },
  );
  assert.equal(res.status, 200);
  assert.equal(calls[0].samples, audio.length);
  assert.equal(res.headers.get("x-rtech-audio-kept-ms"), "8000");
});

test("upstream 500 is 502 upstream_error with upstream_status", async () => {
  const { app } = setup({ reply: () => new Response("boom", { status: 500 }) });
  const res = await post(app, makePcmWav(tone(1), RATE));
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), {
    error: { message: "upstream returned an error" },
    code: "upstream_error",
    data: { upstream_status: 500 },
  });
});

test("an upstream abort is 504 upstream_timeout", async () => {
  const { app } = setup({
    reply: () => {
      throw new DOMException("The operation was aborted", "TimeoutError");
    },
  });
  const res = await post(app, makePcmWav(tone(1), RATE));
  assert.equal(res.status, 504);
  assert.equal((await res.json()).code, "upstream_timeout");
});

test("a network error is 503 upstream_unavailable", async () => {
  const { app } = setup({
    reply: () => {
      throw new TypeError("fetch failed");
    },
  });
  const res = await post(app, makePcmWav(tone(1), RATE));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, "upstream_unavailable");
});

test("a burst beyond 20 is 429 with Retry-After", async () => {
  const { app, calls } = setup();
  const wav = makePcmWav(tone(1), RATE);
  for (let i = 0; i < 20; i += 1) {
    assert.equal((await post(app, wav)).status, 200);
  }
  const res = await post(app, wav);
  assert.equal(res.status, 429);
  assert.equal((await res.json()).code, "rate_limited");
  assert.ok(Number(res.headers.get("retry-after")) >= 1);
  assert.equal(calls.length, 20);
});

test("the log never contains transcript text or the prompt", async () => {
  const { app, lines } = setup({
    reply: () => Response.json({ text: "secret transcript words." }),
  });
  const res = await post(app, makePcmWav(tone(1), RATE), {
    prompt: "private prompt vocabulary",
  });
  assert.equal(res.status, 200);
  assert.equal(lines.length, 1);
  const log = lines.join("\n");
  assert.ok(!log.includes("secret transcript"));
  assert.ok(!log.includes("private prompt"));
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.device_id, "device-1");
  assert.equal(entry.status, 200);
  assert.equal(entry.chunks, 1);
  assert.equal(entry.upstream_status, 200);
  assert.equal(entry.original_ms, 1000);
});
