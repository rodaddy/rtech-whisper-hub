// The voice relay end to end through createApp: device auth, the shared GPU
// semaphore, the missing-profile 503, and the 30 s body-read 408.
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { after, before, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import pino from "pino";
import { createApp } from "../src/app.ts";
import type { Db } from "../src/db/client.ts";
import { mintDevice } from "../src/keys.ts";
import type { Clock } from "../src/voice/limits.ts";
import type { VoiceProfile } from "../src/voice/profile.ts";
import { makePcmWav } from "../src/voice/wav.ts";
import { testDb } from "./helpers.ts";

const STT = "/api/voice/v1/audio/transcriptions";
const TTS = "/api/voice/upstream/omnivoice/synthesize";
const ADMIN = "a".repeat(40);

const wav24k = Buffer.from(
  makePcmWav(new Int16Array([1, -1, 2, -2]), 24_000),
).toString("base64");
const profile: VoiceProfile = {
  audioBase64: wav24k,
  promptText: "Skippy the Magnificent.",
};

/** A clock whose timers fire only when the test advances it. */
class FakeClock implements Clock {
  t = 1_000_000;
  timers: { at: number; fn: () => void; ms: number }[] = [];
  now(): number {
    return this.t;
  }
  setTimer(fn: () => void, ms: number): () => void {
    const timer = { at: this.t + ms, fn, ms };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((x) => x !== timer);
    };
  }
  advance(ms: number): void {
    this.t += ms;
    const due = this.timers.filter((x) => x.at <= this.t);
    this.timers = this.timers.filter((x) => x.at > this.t);
    for (const x of due) x.fn();
  }
}

let db: Db;
let client: PGlite;
let key: string;

before(async () => {
  ({ db, client } = await testDb());
  key = (await mintDevice(db, "iphone", "rico")).key;
});
after(async () => client.close());

type Upstream = (url: string) => Response | Promise<Response>;

function harness(
  opts: {
    profile?: VoiceProfile | null;
    upstream?: Upstream;
    globalConcurrency?: number;
  } = {},
) {
  const calls: string[] = [];
  const clock = new FakeClock();
  const defaultUpstream: Upstream = (url) =>
    url.endsWith("/v1/audio/transcriptions")
      ? Response.json({ text: "hello world." })
      : Response.json({ audio_base64: wav24k, sample_rate: 24_000 });
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    return (opts.upstream ?? defaultUpstream)(url);
  }) as typeof globalThis.fetch;
  const app = createApp({
    db,
    logger: pino(
      { level: "silent" },
      new Writable({ write: (_c, _e, cb) => cb() }),
    ),
    adminToken: ADMIN,
    ownerId: "rico",
    voiceConfig: {
      VOICE_UPSTREAM_URL: "http://upstream.test",
      VOICE_STT_MODEL: "whisper-large-v3-turbo",
    },
    fetch,
    clock,
    voiceProfile: opts.profile === undefined ? profile : opts.profile,
    globalConcurrency: opts.globalConcurrency,
  });
  return { app, calls, clock };
}

const auth = (k: string) => ({ Authorization: `Bearer ${k}` });

function sttForm(): FormData {
  const pcm = new Int16Array(16_000);
  for (let i = 0; i < pcm.length; i += 1) {
    pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 16_000));
  }
  const form = new FormData();
  form.set(
    "file",
    new Blob([makePcmWav(pcm, 16_000) as Uint8Array<ArrayBuffer>], {
      type: "audio/wav",
    }),
    "a.wav",
  );
  return form;
}

const transcribe = (app: ReturnType<typeof harness>["app"], k?: string) =>
  app.request(STT, {
    method: "POST",
    body: sttForm(),
    headers: { ...(k ? auth(k) : {}), "x-rtech-client-trimmed": "1" },
  });

const synthesize = (app: ReturnType<typeof harness>["app"], k?: string) =>
  app.request(TTS, {
    method: "POST",
    body: JSON.stringify({ text: "hello" }),
    headers: { ...(k ? auth(k) : {}), "content-type": "application/json" },
  });

const ticks = async (n = 20) => {
  for (let i = 0; i < n; i += 1) await new Promise(setImmediate);
};

/** Yield until `pred` holds; fail instead of hanging. */
const until = async (pred: () => boolean) => {
  for (let i = 0; i < 1000; i += 1) {
    if (pred()) return;
    await ticks(1);
  }
  assert.fail("condition never became true");
};

test("transcription: 401 without a device key, 200 text with one", async () => {
  const { app, calls } = harness();
  const denied = await transcribe(app);
  assert.equal(denied.status, 401);
  assert.equal(calls.length, 0);

  const res = await transcribe(app, key);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { text: "hello world." });
  assert.deepEqual(calls, ["http://upstream.test/v1/audio/transcriptions"]);
});

test("synthesis: 503 without a server profile, 200 with one", async () => {
  const none = harness({ profile: null });
  const res503 = await synthesize(none.app, key);
  assert.equal(res503.status, 503);
  assert.equal(
    ((await res503.json()) as { code: string }).code,
    "upstream_unavailable",
  );
  assert.equal(none.calls.length, 0);

  const withProfile = harness();
  const res = await synthesize(withProfile.app, key);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    audio_base64: wav24k,
    sample_rate: 24_000,
  });
  assert.deepEqual(withProfile.calls, [
    "http://upstream.test/upstream/omnivoice/synthesize",
  ]);
});

test("the admin token is not a device key on /api/voice", async () => {
  const { app, calls } = harness();
  assert.equal((await transcribe(app, ADMIN)).status, 401);
  assert.equal((await synthesize(app, ADMIN)).status, 401);
  assert.equal(calls.length, 0);
});

test("one semaphore across both routes: synthesis waits for a transcription's slot", async () => {
  const events: string[] = [];
  let finishStt!: () => void;
  const sttHeld = new Promise<void>((r) => (finishStt = r));
  const { app } = harness({
    globalConcurrency: 1,
    upstream: async (url) => {
      if (url.endsWith("/v1/audio/transcriptions")) {
        events.push("stt start");
        await sttHeld;
        events.push("stt end");
        return Response.json({ text: "hello world." });
      }
      events.push("tts start");
      return Response.json({ audio_base64: wav24k, sample_rate: 24_000 });
    },
  });

  const stt = transcribe(app, key);
  await until(() => events.includes("stt start"));
  const tts = synthesize(app, key);
  await ticks();
  assert.deepEqual(
    events,
    ["stt start"],
    "synthesis reached upstream while the only slot was held",
  );

  finishStt();
  const [a, b] = await Promise.all([stt, tts]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(events, ["stt start", "stt end", "tts start"]);
});

/** A request whose body never finishes arriving. */
function stalled(path: string, contentType: string): Request {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode("{"));
    },
  });
  return new Request(`http://hub${path}`, {
    method: "POST",
    headers: { ...auth(key), "content-type": contentType },
    body,
    duplex: "half",
  } as RequestInit);
}

for (const [route, path, type] of [
  ["synthesis", TTS, "application/json"],
  ["transcription", STT, "multipart/form-data; boundary=x"],
] as const) {
  test(`${route}: a body not received within 30 s is 408 request_timeout`, async () => {
    const { app, clock, calls } = harness();
    const pending = Promise.resolve(app.fetch(stalled(path, type)));
    await until(() => clock.timers.some((x) => x.ms === 30_000));
    let settled = false;
    void pending.then(() => (settled = true));
    clock.advance(29_999);
    await ticks();
    assert.equal(settled, false, "answered before the 30 s deadline");
    clock.advance(1);
    const res = await pending;
    assert.equal(res.status, 408);
    assert.equal(
      ((await res.json()) as { code: string }).code,
      "request_timeout",
    );
    assert.equal(calls.length, 0);
  });
}
