import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  InFlight,
  ROUTE_LIMITS,
  Semaphore,
  TokenBucket,
} from "../src/voice/limits.ts";
import { loadVoiceProfile, type VoiceProfile } from "../src/voice/profile.ts";
import { synthesizeRoutes } from "../src/voice/synthesizeRoute.ts";
import { makePcmWav } from "../src/voice/wav.ts";

// Set TMPDIR to move the test's scratch profile directory.
const TEMP_ROOT = tmpdir();
const URL_PATH = "http://hub/voice/upstream/omnivoice/synthesize";
const SECRET_TEXT = "the quick brown fox says a secret";

const wav24k = Buffer.from(
  makePcmWav(new Int16Array([1, -1, 2, -2]), 24_000),
).toString("base64");
const wav16k = Buffer.from(
  makePcmWav(new Int16Array([1, -1, 2, -2]), 16_000),
).toString("base64");

let profileDir: string;
let profile: VoiceProfile;

before(async () => {
  await mkdir(TEMP_ROOT, { recursive: true });
  profileDir = await mkdtemp(join(TEMP_ROOT, "voice-profile-"));
  await writeFile(
    join(profileDir, "ref.wav"),
    makePcmWav(new Int16Array([5, 6, 7]), 24_000),
  );
  await writeFile(join(profileDir, "ref.txt"), "  This is the server voice.\n");
  const loaded = await loadVoiceProfile(profileDir);
  assert.ok(loaded.ok);
  profile = loaded.profile;
});

after(async () => {
  await rm(profileDir, { recursive: true, force: true });
});

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function harness(opts: {
  profile?: VoiceProfile | null;
  upstream?: (call: Call) => Response | Promise<Response>;
  apiKey?: string;
}) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: String(url),
      init: init ?? {},
      body: JSON.parse(String(init?.body)),
    };
    calls.push(call);
    return opts.upstream
      ? opts.upstream(call)
      : Response.json({ audio_base64: wav24k, sample_rate: 24_000 });
  }) as typeof globalThis.fetch;
  const app = synthesizeRoutes({
    config: {
      VOICE_UPSTREAM_URL: "http://upstream.test/",
      VOICE_UPSTREAM_API_KEY: opts.apiKey,
    },
    logger: {
      info: (obj: unknown, msg?: string) =>
        logs.push(JSON.stringify({ obj, msg })),
    } as never,
    fetch,
    limiters: {
      rate: new TokenBucket({
        capacity: ROUTE_LIMITS.synthesis.burst,
        perMinute: ROUTE_LIMITS.synthesis.perMinute,
      }),
      inFlight: new InFlight(ROUTE_LIMITS.synthesis.inFlight),
      upstream: new Semaphore({ max: 4, maxWaitMs: 10_000 }),
    },
    profile: opts.profile === undefined ? profile : opts.profile,
    getDeviceId: () => "dev-1",
  });
  const post = (body: unknown) =>
    app.request(URL_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { post, calls, logs };
}

test("profile loader trims ref.txt and base64-encodes ref.wav", async () => {
  assert.equal(profile.promptText, "This is the server voice.");
  assert.equal(
    Buffer.from(profile.audioBase64, "base64").subarray(0, 4).toString(),
    "RIFF",
  );
});

test("profile loader names missing files and an unset directory", async () => {
  const unset = await loadVoiceProfile(undefined);
  assert.deepEqual(unset.ok ? null : unset.code, "not_configured");
  const empty = await mkdtemp(join(TEMP_ROOT, "voice-empty-"));
  try {
    const r = await loadVoiceProfile(empty);
    assert.ok(!r.ok);
    assert.equal(r.code, "missing_files");
    assert.match(r.message, /ref\.wav and ref\.txt/);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test("no voice fields: the hub fills in the server voice profile", async () => {
  const h = harness({ apiKey: "up-key" });
  const res = await h.post({ text: `  ${SECRET_TEXT}  ` });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    audio_base64: wav24k,
    sample_rate: 24_000,
  });
  assert.equal(h.calls.length, 1);
  assert.equal(
    h.calls[0].url,
    "http://upstream.test/upstream/omnivoice/synthesize",
  );
  assert.deepEqual(h.calls[0].body, {
    text: SECRET_TEXT,
    audio_base64: profile.audioBase64,
    prompt_text: "This is the server voice.",
  });
  assert.equal(
    (h.calls[0].init.headers as Record<string, string>).authorization,
    "Bearer up-key",
  );
});

test("both voice fields: passed through, no upstream key header when unset", async () => {
  const h = harness({});
  const res = await h.post({
    text: "hi",
    audio_base64: "Y2xpZW50",
    prompt_text: "client prompt",
  });
  assert.equal(res.status, 200);
  assert.deepEqual(h.calls[0].body, {
    text: "hi",
    audio_base64: "Y2xpZW50",
    prompt_text: "client prompt",
  });
  assert.equal(
    (h.calls[0].init.headers as Record<string, string>).authorization,
    undefined,
  );
});

test("only one voice field -> 400 invalid_request", async () => {
  const h = harness({});
  for (const body of [
    { text: "hi", audio_base64: "Y2xpZW50" },
    { text: "hi", prompt_text: "p" },
  ]) {
    const res = await h.post(body);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "invalid_request");
  }
  assert.equal(h.calls.length, 0);
});

test("2001 characters -> 400 text_too_long; 2000 is accepted", async () => {
  const h = harness({});
  const long = await h.post({ text: "a".repeat(2001) });
  assert.equal(long.status, 400);
  assert.equal((await long.json()).code, "text_too_long");
  assert.equal((await h.post({ text: "a".repeat(2000) })).status, 200);
});

test("no profile and no voice fields -> 503 upstream_unavailable", async () => {
  const h = harness({ profile: null });
  const res = await h.post({ text: "hi" });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.code, "upstream_unavailable");
  assert.equal(body.error.message, "voice profile not configured");
  assert.equal(h.calls.length, 0);
});

test("upstream returns 16 kHz audio -> 502 upstream_error", async () => {
  const h = harness({
    upstream: () =>
      Response.json({ audio_base64: wav16k, sample_rate: 24_000 }),
  });
  const res = await h.post({ text: "hi" });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).code, "upstream_error");
});

test("upstream 500 -> 502 with data.upstream_status", async () => {
  const h = harness({ upstream: () => new Response("boom", { status: 500 }) });
  const res = await h.post({ text: "hi" });
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), {
    error: { message: "voice upstream failed" },
    code: "upstream_error",
    data: { upstream_status: 500 },
  });
});

test("upstream timeout -> 504 upstream_timeout", async () => {
  const h = harness({
    upstream: () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    },
  });
  const res = await h.post({ text: "hi" });
  assert.equal(res.status, 504);
  assert.equal((await res.json()).code, "upstream_timeout");
});

test("upstream network failure -> 503 upstream_unavailable", async () => {
  const h = harness({
    upstream: () => {
      throw new TypeError("fetch failed");
    },
  });
  const res = await h.post({ text: "hi" });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, "upstream_unavailable");
});

test("the 6th request in a burst -> 429 with Retry-After", async () => {
  const h = harness({});
  for (let i = 0; i < 5; i += 1)
    assert.equal((await h.post({ text: "hi" })).status, 200);
  const res = await h.post({ text: "hi" });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).code, "rate_limited");
  assert.ok(Number(res.headers.get("retry-after")) >= 1);
});

test("body over 4 MB -> 413 payload_too_large", async () => {
  const h = harness({});
  const res = await h.post({ text: "hi", pad: "x".repeat(4 * 1024 * 1024) });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).code, "payload_too_large");
});

test("logs never carry text, prompt_text, or audio", async () => {
  const h = harness({});
  await h.post({ text: SECRET_TEXT });
  await h.post({
    text: SECRET_TEXT,
    audio_base64: "Y2xpZW50",
    prompt_text: "client prompt",
  });
  await h.post({ text: "a".repeat(2001) });
  assert.ok(h.logs.length >= 3);
  const all = h.logs.join("\n");
  for (const secret of [
    SECRET_TEXT,
    "client prompt",
    "Y2xpZW50",
    "This is the server voice",
    wav24k,
    profile.audioBase64,
    "aaaa",
  ]) {
    assert.ok(!all.includes(secret), `log leaked ${secret.slice(0, 20)}`);
  }
  assert.match(all, /"device_id":"dev-1"/);
});

test("render settings: the four optional fields reach the upstream request", async () => {
  const h = harness({});
  const res = await h.post({
    text: "hi",
    seed: 42,
    num_steps: 16,
    guidance_scale: 2.5,
    language: "en",
  });
  assert.equal(res.status, 200);
  assert.deepEqual(h.calls[0].body, {
    text: "hi",
    audio_base64: profile.audioBase64,
    prompt_text: "This is the server voice.",
    seed: 42,
    num_steps: 16,
    guidance_scale: 2.5,
    language: "en",
  });
});

test("render settings out of range or of the wrong type -> 400 invalid_request, upstream not called", async () => {
  for (const body of [
    { text: "hi", seed: 0 },
    { text: "hi", seed: 1001 },
    { text: "hi", seed: "7" },
    { text: "hi", seed: null },
    { text: "hi", num_steps: 9 },
    { text: "hi", num_steps: 21 },
    { text: "hi", guidance_scale: 0 },
    { text: "hi", guidance_scale: -1 },
    { text: "hi", guidance_scale: 10.5 },
    { text: "hi", language: "" },
    { text: "hi", language: "a".repeat(33) },
  ]) {
    // A harness per case: the synthesis bucket allows a burst of 5.
    const h = harness({});
    const res = await h.post(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    const json = await res.json();
    assert.equal(json.code, "invalid_request", JSON.stringify(body));
    assert.equal(h.calls.length, 0, JSON.stringify(body));
  }
});

test("a bad render field gets the message naming the render limits; a bad text keeps its own", async () => {
  const h = harness({});
  const render = await (await h.post({ text: "hi", seed: 0 })).json();
  assert.match(render.error.message, /seed/);
  const text = await (await h.post({ text: 5 })).json();
  assert.equal(
    text.error.message,
    "text must be a string; audio_base64 and prompt_text, when sent, non-empty strings",
  );
  assert.equal(h.calls.length, 0);
});

test("no render settings: the upstream body is exactly text plus the voice", async () => {
  const h = harness({});
  const res = await h.post({
    text: "hi",
    audio_base64: "Y2xpZW50",
    prompt_text: "client prompt",
  });
  assert.equal(res.status, 200);
  assert.equal(
    String(h.calls[0].init.body),
    '{"text":"hi","audio_base64":"Y2xpZW50","prompt_text":"client prompt"}',
  );
});

test("the hub's own voice: the upstream body is exactly text, the profile, then the render settings in order", async () => {
  const h = harness({});
  const voice = `"audio_base64":${JSON.stringify(profile.audioBase64)},"prompt_text":"This is the server voice."`;
  assert.equal((await h.post({ text: "hi" })).status, 200);
  assert.equal(String(h.calls[0].init.body), `{"text":"hi",${voice}}`);
  // Sent in a different order than the hub forwards them.
  const res = await h.post({
    language: "en",
    guidance_scale: 2.5,
    num_steps: 16,
    seed: 42,
    text: "hi",
  });
  assert.equal(res.status, 200);
  assert.equal(
    String(h.calls[1].init.body),
    `{"text":"hi",${voice},"seed":42,"num_steps":16,"guidance_scale":2.5,"language":"en"}`,
  );
});
