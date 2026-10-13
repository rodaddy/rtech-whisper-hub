// The speech route as a stock client sees it: the
// official openai SDK, pointed at the hub's voice base URL with a device key,
// against a stubbed voice server. No listener is started; the SDK's fetch is
// app.fetch.
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { after, before, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import OpenAI from "openai";
import pino from "pino";
import { createApp } from "../src/app.ts";
import type { Db } from "../src/db/client.ts";
import { mintDevice } from "../src/keys.ts";
import { isSynthesisWav } from "../src/voice/synthesizeRoute.ts";
import { makePcmWav } from "../src/voice/wav.ts";
import { testDb } from "./helpers.ts";

const wav24k = Buffer.from(
  makePcmWav(new Int16Array([1, -1, 2, -2]), 24_000),
).toString("base64");

let db: Db;
let pg: PGlite;
let key: string;

before(async () => {
  ({ db, client: pg } = await testDb());
  key = (await mintDevice(db, "sdk", "rico")).key;
});
after(async () => pg.close());

function sdk() {
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
    fetch: (async () =>
      Response.json({
        audio_base64: wav24k,
        sample_rate: 24_000,
      })) as typeof globalThis.fetch,
    voiceProfile: {
      audioBase64: wav24k,
      promptText: "Skippy the Magnificent.",
    },
  });
  return new OpenAI({
    baseURL: "http://hub.test/api/voice/v1",
    apiKey: key,
    maxRetries: 0,
    fetch: async (url, init) => app.fetch(new Request(url, init)),
  });
}

test("the openai SDK gets WAV bytes from audio.speech.create", async () => {
  const res = await sdk().audio.speech.create({
    model: "omnivoice",
    voice: "skippy",
    input: "hi",
    response_format: "wav",
  });
  assert.ok(isSynthesisWav(new Uint8Array(await res.arrayBuffer())));
});

test("an unknown voice is the SDK's BadRequestError with code invalid_request", async () => {
  await assert.rejects(
    sdk().audio.speech.create({
      model: "omnivoice",
      voice: "alloy",
      input: "hi",
    }),
    (err) => {
      assert.ok(err instanceof OpenAI.BadRequestError);
      assert.equal(err.status, 400);
      assert.equal(err.code, "invalid_request");
      return true;
    },
  );
});
