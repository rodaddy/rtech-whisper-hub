// The OpenAI-shaped speech route, the voices list and the discovery document
// (rtech-whisper-hub#133), through createApp so the shared synthesis budget
// and the device auth are the real wiring.
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { after, before, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import pino from "pino";
import { createApp } from "../src/app.ts";
import type { Db } from "../src/db/client.ts";
import { mintDevice } from "../src/keys.ts";
import type { VoiceProfile } from "../src/voice/profile.ts";
import { isSynthesisWav } from "../src/voice/synthesizeRoute.ts";
import { makePcmWav } from "../src/voice/wav.ts";
import { testDb } from "./helpers.ts";

const SPEECH = "/api/voice/v1/audio/speech";
const SAMPLES = new Int16Array([1, -1, 2, -2]);
const wav24k = Buffer.from(makePcmWav(SAMPLES, 24_000)).toString("base64");
const profile: VoiceProfile = {
  audioBase64: Buffer.from(
    makePcmWav(new Int16Array([5, 6, 7]), 24_000),
  ).toString("base64"),
  promptText: "Skippy the Magnificent.",
};

let db: Db;
let client: PGlite;
let key: string;

before(async () => {
  ({ db, client } = await testDb());
  key = (await mintDevice(db, "iphone", "rico")).key;
});
after(async () => client.close());

function harness(opts: { profile?: VoiceProfile | null } = {}) {
  const calls: Record<string, unknown>[] = [];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    return Response.json({ audio_base64: wav24k, sample_rate: 24_000 });
  }) as typeof globalThis.fetch;
  const app = createApp({
    db,
    logger: pino(
      { level: "silent" },
      new Writable({ write: (_c, _e, cb) => cb() }),
    ),
    adminToken: "a".repeat(40),
    ownerId: "rico",
    voiceConfig: {
      VOICE_UPSTREAM_URL: "http://upstream.test",
      VOICE_STT_MODEL: "whisper-large-v3-turbo",
    },
    fetch,
    voiceProfile: opts.profile === undefined ? profile : opts.profile,
  });
  const headers = {
    Authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };
  const post = (body: unknown, path = SPEECH) =>
    app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
  const get = (path: string) => app.request(path, { headers });
  return { post, get, calls };
}

test("voice skippy: WAV bytes, rendered from the server profile and the trimmed input", async () => {
  const h = harness();
  const res = await h.post({
    model: "tts-1",
    voice: "Skippy",
    input: "  hello there  ",
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "audio/wav");
  assert.equal(res.headers.get("x-speech-warning"), null);
  assert.ok(isSynthesisWav(new Uint8Array(await res.arrayBuffer())));
  assert.deepEqual(h.calls, [
    {
      text: "hello there",
      audio_base64: profile.audioBase64,
      prompt_text: profile.promptText,
    },
  ]);
});

test("response_format pcm: exactly the WAV's data bytes", async () => {
  const h = harness();
  const res = await h.post({
    voice: "skippy",
    input: "hi",
    response_format: "pcm",
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "audio/pcm");
  assert.deepEqual(
    Buffer.from(await res.arrayBuffer()),
    Buffer.from(makePcmWav(SAMPLES, 24_000)).subarray(44),
  );
});

test("an unknown voice -> 400 with the OpenAI error keys, upstream not called", async () => {
  const h = harness();
  const res = await h.post({ voice: "alloy", input: "hi" });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), {
    error: {
      message: "unknown voice",
      type: "invalid_request_error",
      code: "invalid_request",
    },
    code: "invalid_request",
  });
  assert.equal(h.calls.length, 0);
});

test("no profile configured -> 503 upstream_unavailable, as the 10.2 route answers", async () => {
  const h = harness({ profile: null });
  const res = await h.post({ voice: "skippy", input: "hi" });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.code, "upstream_unavailable");
  assert.equal(body.error.type, "server_error");
  assert.equal(h.calls.length, 0);
});

test("speed other than 1 sets the warning header", async () => {
  const h = harness();
  const res = await h.post({ voice: "skippy", input: "hi", speed: 1.5 });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-speech-warning"), "speed is ignored");
});

test("the speech route and the 10.2 route share one rate budget", async () => {
  const h = harness();
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await h.post({ voice: "skippy", input: "hi" })).status, 200);
  }
  const res = await h.post(
    { text: "hi" },
    "/api/voice/upstream/omnivoice/synthesize",
  );
  assert.equal(res.status, 429);
  assert.equal((await res.json()).code, "rate_limited");
});

test("the voices list names Skippy only when the profile is configured", async () => {
  const withProfile = await harness().get("/api/voice/v1/audio/voices");
  assert.deepEqual(await withProfile.json(), {
    voices: [{ id: "skippy", name: "Skippy" }],
  });
  const without = await harness({ profile: null }).get(
    "/api/voice/v1/audio/voices",
  );
  assert.deepEqual(await without.json(), { voices: [] });
});

test("the discovery document lists the routes as relative URLs", async () => {
  const res = await harness().get("/api/voice/.well-known/speech");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    speech: "v1/audio/speech",
    voices: "v1/audio/voices",
    transcriptions: "v1/audio/transcriptions",
    response_formats: ["wav", "pcm"],
    sample_rate: 24000,
  });
});
