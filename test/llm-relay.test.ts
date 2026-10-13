// The LLM relay (docs/protocol.md 11) against a fake upstream: auth, the
// non-stream and SSE pass-throughs, limits, config, and error mapping.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import pino from "pino";
import { Writable } from "node:stream";
import { createApp } from "../src/app.ts";
import type { Db } from "../src/db/client.ts";
import { mintDevice } from "../src/keys.ts";
import {
  LLM_LIMITS,
  type LlmUpstream,
  llmRoutes,
  namesModel,
  resolveLlmUpstream,
  upstreamRetryAfter,
} from "../src/llm/relay.ts";
import { type Clock, InFlight, TokenBucket } from "../src/voice/limits.ts";
import { testDb } from "./helpers.ts";

const CHAT = "http://hub/llm/v1/chat/completions";
const MODELS = "http://hub/llm/v1/models";
const SECRET = "tell nobody: the launch code is 0000";
const COMPLETION = {
  id: "c1",
  object: "chat.completion",
  choices: [{ index: 0, message: { role: "assistant", content: "hi" } }],
};

interface Call {
  url: string;
  init: RequestInit;
}

const UPSTREAM: LlmUpstream = {
  url: "http://llama.test/",
  apiKey: "upstream-key",
  allowlist: [],
};

function harness(opts: {
  upstream?: Partial<LlmUpstream>;
  reply?: (call: Call) => Response | Promise<Response>;
  clock?: Clock;
}) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const inFlight = new InFlight(LLM_LIMITS.inFlight);
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return opts.reply ? opts.reply(call) : Response.json(COMPLETION);
  }) as typeof globalThis.fetch;
  const app = llmRoutes({
    upstream: { ...UPSTREAM, ...opts.upstream },
    logger: {
      info: (obj: unknown, msg?: string) =>
        logs.push(JSON.stringify({ obj, msg })),
    } as never,
    fetch,
    clock: opts.clock,
    limiters: {
      rate: new TokenBucket({
        capacity: LLM_LIMITS.burst,
        perMinute: LLM_LIMITS.perMinute,
      }),
      inFlight,
    },
    getDeviceId: () => "dev-1",
  });
  const chat = async (body: unknown, signal?: AbortSignal) =>
    app.request(
      new Request(CHAT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
        signal,
      }),
    );
  const slots = () => inFlight.count("dev-1", "llm");
  return { app, chat, calls, logs, slots };
}

const ask = (extra: Record<string, unknown> = {}) => ({
  model: "qwen3-8b",
  messages: [{ role: "user", content: SECRET }],
  ...extra,
});

function sse(chunks: string[], hold?: Promise<void>): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(ctl) {
        for (const c of chunks) ctl.enqueue(enc.encode(c));
        if (hold) await hold;
        ctl.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

// ---- auth through createApp ----

let db: Db;
let client: PGlite;
let key: string;
before(async () => {
  ({ db, client } = await testDb());
  key = (await mintDevice(db, "iphone", "rico")).key;
});
after(async () => client.close());

function fullApp(llmUpstream?: LlmUpstream) {
  const sink = new Writable({ write: (_c, _e, cb) => cb() });
  return createApp({
    db,
    logger: pino({ level: "silent" }, sink),
    adminToken: "a".repeat(40),
    ownerId: "rico",
    llmUpstream,
    fetch: (async () => Response.json(COMPLETION)) as typeof globalThis.fetch,
  });
}

test("401 without a device key, and upstream is never called", async () => {
  const app = fullApp(UPSTREAM);
  for (const auth of [undefined, "Bearer nope"]) {
    const res = await app.request("/api/llm/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(auth ? { authorization: auth } : {}),
      },
      body: JSON.stringify(ask()),
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, "unauthorized");
  }
});

test("a device key reaches the relay through createApp", async () => {
  const res = await fullApp(UPSTREAM).request("/api/llm/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(ask()),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), COMPLETION);
});

test("createApp with no LLM upstream answers 503 upstream_unavailable", async () => {
  const res = await fullApp().request("/api/llm/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(ask()),
  });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, "upstream_unavailable");
});

// ---- the relay itself ----

test("non-stream: every body field reaches upstream and the reply comes back as-is", async () => {
  const { chat, calls, logs } = harness({});
  const sent = JSON.stringify(ask({ temperature: 0.2, custom_field: [1, 2] }));
  const res = await chat(sent);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), COMPLETION);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://llama.test/v1/chat/completions");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), JSON.parse(sent));
  const h = calls[0].init.headers as Record<string, string>;
  assert.equal(h.authorization, "Bearer upstream-key");
  // Prompts and completions are never logged.
  assert.ok(logs.length > 0);
  for (const line of logs) assert.ok(!line.includes("launch code"));
  assert.match(logs.at(-1)!, /"status":200/);
});

test("stream: upstream request is JSON with an SSE accept (llama-swap needs the content-type)", async () => {
  const { chat, calls } = harness({ reply: () => sse(["data: [DONE]\n\n"]) });
  const res = await chat(ask({ stream: true }));
  assert.equal(res.status, 200);
  await res.text();
  const h = calls[0].init.headers as Record<string, string>;
  assert.equal(h["content-type"], "application/json");
  assert.equal(h.accept, "text/event-stream");
});

test("stream: SSE chunks are relayed in order and the slot is released at the end", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"b"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"c"}}]}\n\n',
    "data: [DONE]\n\n",
  ];
  const { chat, calls } = harness({ reply: () => sse(chunks) });
  const res = await chat(ask({ stream: true }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.equal(await res.text(), chunks.join(""));
  assert.equal(
    (calls[0].init.headers as Record<string, string>).accept,
    "text/event-stream",
  );
  // Both in-flight slots are free again: two more streams are admitted.
  const again = await Promise.all([
    chat(ask({ stream: true })),
    chat(ask({ stream: true })),
  ]);
  for (const r of again) {
    assert.equal(r.status, 200);
    await r.text();
  }
});

test("429 at the in-flight cap: a third concurrent request is refused", async () => {
  let open!: () => void;
  const hold = new Promise<void>((r) => {
    open = r;
  });
  const { chat } = harness({ reply: () => sse(["data: x\n\n"], hold) });
  const a = await chat(ask({ stream: true }));
  const b = await chat(ask({ stream: true }));
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const c = await chat(ask({ stream: true }));
  assert.equal(c.status, 429);
  assert.equal(c.headers.get("retry-after"), "1");
  assert.equal((await c.json()).code, "rate_limited");
  open();
  await a.text();
  await b.text();
});

test("429 with Retry-After once the rate bucket is empty", async () => {
  const { chat } = harness({});
  for (let i = 0; i < LLM_LIMITS.burst; i++) {
    assert.equal((await chat(ask())).status, 200);
  }
  const res = await chat(ask());
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get("retry-after")) >= 1);
});

test("413 over the 1 MB body cap, upstream never called", async () => {
  const { chat, calls } = harness({});
  const res = await chat(ask({ pad: "x".repeat(LLM_LIMITS.bodyBytes) }));
  assert.equal(res.status, 413);
  assert.equal((await res.json()).code, "payload_too_large");
  assert.equal(calls.length, 0);
});

test("503 when the relay is not configured", async () => {
  const { chat, app, calls } = harness({ upstream: { url: undefined } });
  const res = await chat(ask());
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, "upstream_unavailable");
  assert.equal((await app.request(MODELS)).status, 503);
  assert.equal(calls.length, 0);
});

test("allowlist: an unlisted model is 400 model_not_allowed; a listed one passes", async () => {
  const { chat, calls } = harness({ upstream: { allowlist: ["qwen3-8b"] } });
  const bad = await chat(ask({ model: "llama-70b" }));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, "model_not_allowed");
  assert.equal(calls.length, 0);
  assert.equal((await chat(ask())).status, 200);
});

test("400 invalid_request for non-JSON or a body without model and messages", async () => {
  const { chat, calls } = harness({});
  for (const body of ["not json", { messages: [] }, { model: "m" }]) {
    const res = await chat(body);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "invalid_request");
  }
  assert.equal(calls.length, 0);
});

test("upstream 500 maps to 502 upstream_error with the upstream status", async () => {
  const { chat } = harness({
    reply: () => new Response("boom", { status: 500 }),
  });
  const res = await chat(ask());
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), {
    error: { message: "LLM upstream failed" },
    code: "upstream_error",
    data: { upstream_status: 500 },
  });
});

test("upstream 400 maps to 400 upstream_rejected (not retryable)", async () => {
  const { chat } = harness({
    reply: () => new Response("{}", { status: 400 }),
  });
  const res = await chat(ask());
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "upstream_rejected");
});

test("a 200 that is not a chat completion is 502", async () => {
  const { chat } = harness({ reply: () => new Response("<html>") });
  const res = await chat(ask());
  assert.equal(res.status, 502);
  assert.equal((await res.json()).code, "upstream_error");
});

test("a stream request answered without SSE is 502", async () => {
  const { chat } = harness({ reply: () => Response.json(COMPLETION) });
  const res = await chat(ask({ stream: true }));
  assert.equal(res.status, 502);
});

test("an unreachable upstream is 503 and an aborted one 504", async () => {
  const down = harness({
    reply: () => {
      throw new TypeError("fetch failed");
    },
  });
  assert.equal((await down.chat(ask())).status, 503);
  const slow = harness({
    reply: () => {
      throw new DOMException("timeout", "AbortError");
    },
  });
  const res = await slow.chat(ask());
  assert.equal(res.status, 504);
  assert.equal((await res.json()).code, "upstream_timeout");
});

test("models: upstream list passes through, filtered by the allowlist", async () => {
  const list = {
    object: "list",
    data: [{ id: "qwen3-8b" }, { id: "llama-70b" }],
  };
  const open = harness({ reply: () => Response.json(list) });
  const res = await open.app.request(MODELS);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), list);
  assert.equal(open.calls[0].url, "http://llama.test/v1/models");

  const limited = harness({
    upstream: { allowlist: ["qwen3-8b"] },
    reply: () => Response.json(list),
  });
  assert.deepEqual(await (await limited.app.request(MODELS)).json(), {
    object: "list",
    data: [{ id: "qwen3-8b" }],
  });
});

test("resolveLlmUpstream: falls back to the voice upstream and its key; an own URL never inherits the voice key", () => {
  const voice = {
    VOICE_UPSTREAM_URL: "https://llama-swap.example.internal",
    VOICE_UPSTREAM_API_KEY: "vk",
  };
  assert.deepEqual(resolveLlmUpstream(voice), {
    url: "https://llama-swap.example.internal",
    apiKey: "vk",
    allowlist: [],
  });
  assert.deepEqual(
    resolveLlmUpstream({
      ...voice,
      LLM_UPSTREAM_URL: "http://other:8080",
      LLM_MODEL_ALLOWLIST: " a, b ,,",
    }),
    { url: "http://other:8080", apiKey: undefined, allowlist: ["a", "b"] },
  );
  assert.equal(
    resolveLlmUpstream({
      ...voice,
      LLM_UPSTREAM_URL: "http://other:8080",
      LLM_UPSTREAM_API_KEY: "lk",
    }).apiKey,
    "lk",
  );
});

// ---- slot release and the idle timer ----

/** A clock whose timers fire only when the test says so. */
function manualClock() {
  const timers = new Set<() => void>();
  const clock: Clock = {
    now: () => 0,
    setTimer(fn) {
      timers.add(fn);
      return () => timers.delete(fn);
    },
  };
  const fire = () => {
    const due = [...timers];
    timers.clear();
    for (const fn of due) fn();
  };
  return { clock, fire, pending: () => timers.size };
}

/**
 * An SSE body that behaves like undici's: aborting the fetch signal errors the
 * body. The chunks are queued at once; the stream then stays open until hold.
 */
function undiciSse(
  signal: AbortSignal | null | undefined,
  chunks: string[],
  hold: Promise<void> = new Promise(() => {}),
): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(ctl) {
        signal?.addEventListener("abort", () => {
          try {
            ctl.error(new DOMException("aborted", "AbortError"));
          } catch {}
        });
        for (const c of chunks) ctl.enqueue(enc.encode(c));
        hold.then(() => {
          try {
            ctl.close();
          } catch {}
        });
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

const tick = () => new Promise((r) => setImmediate(r));

test("a client that leaves before upstream answers frees its slot", async () => {
  const { clock } = manualClock();
  const { chat, slots, calls } = harness({
    clock,
    // Like fetch: rejects once its signal aborts, and never answers otherwise.
    reply: ({ init }) =>
      new Promise<Response>((_, reject) => {
        const no = () => reject(new DOMException("aborted", "AbortError"));
        if (init.signal?.aborted) no();
        init.signal?.addEventListener("abort", no);
      }),
  });
  // One more drop than the in-flight cap: a leak would lock the device out.
  for (let i = 0; i < LLM_LIMITS.inFlight + 1; i++) {
    const client = new AbortController();
    const pending = chat(ask({ stream: true }), client.signal);
    while (calls.length <= i) await tick();
    assert.equal(slots(), 1);
    client.abort();
    await pending.catch(() => {});
    assert.equal(slots(), 0, "the slot is free once the client is gone");
  }
});

test("a client that leaves after headers, without reading, frees its slot", async () => {
  const { clock, pending } = manualClock();
  const client = new AbortController();
  const { chat, slots, logs } = harness({
    clock,
    reply: ({ init }) => undiciSse(init.signal, ["data: a\n\n"]),
  });
  const res = await chat(ask({ stream: true }), client.signal);
  assert.equal(res.status, 200);
  assert.equal(slots(), 1);
  client.abort();
  await tick();
  assert.equal(slots(), 0);
  assert.equal(pending(), 0, "no idle timer left behind");
  assert.match(logs.at(-1)!, /"code":"client_closed"/);
});

test("a client already gone when upstream answers frees its slot", async () => {
  const { clock } = manualClock();
  const client = new AbortController();
  const { chat, slots } = harness({
    clock,
    reply: ({ init }) => {
      client.abort();
      return undiciSse(init.signal, ["data: a\n\n"]);
    },
  });
  await chat(ask({ stream: true }), client.signal).catch(() => {});
  await tick();
  assert.equal(slots(), 0);
});

test("an idle upstream stream ends with the upstream_timeout event and frees the slot", async () => {
  const { clock, fire } = manualClock();
  const { chat, slots, logs } = harness({
    clock,
    reply: ({ init }) => undiciSse(init.signal, ["data: a\n\n"]),
  });
  const res = await chat(ask({ stream: true }));
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  assert.equal(dec.decode((await reader.read()).value), "data: a\n\n");
  const next = reader.read();
  await tick();
  fire();
  const last = await next;
  assert.equal(
    dec.decode(last.value),
    'data: {"error":{"message":"LLM upstream stream went idle"},"code":"upstream_timeout"}\n\n',
  );
  assert.equal((await reader.read()).done, true);
  assert.equal(slots(), 0);
  assert.match(logs.at(-1)!, /"code":"upstream_timeout"/);
});

test("a slow reader is not an idle upstream: every chunk arrives, no timeout event", async () => {
  const { clock, fire } = manualClock();
  const chunks = ["data: a\n\n", "data: b\n\n", "data: [DONE]\n\n"];
  const { chat, slots } = harness({
    clock,
    reply: ({ init }) => undiciSse(init.signal, chunks, Promise.resolve()),
  });
  const res = await chat(ask({ stream: true }));
  await tick();
  // The client has not read yet, and more than the idle limit passes.
  fire();
  fire();
  assert.equal(await res.text(), chunks.join(""));
  assert.equal(slots(), 0);
});

// ---- review findings: hub #42 #46 #47 #50 ----

test("#42 a duplicate model key cannot smuggle an unlisted model upstream", async () => {
  const { chat, calls } = harness({ upstream: { allowlist: ["qwen3-8b"] } });
  // JSON.parse keeps the last key (validated); a first-key reader would see llama-70b.
  const res = await chat(
    '{"model":"llama-70b","messages":[{"role":"user","content":"hi"}],"model":"qwen3-8b"}',
  );
  assert.equal(res.status, 200);
  const sent = String(calls[0].init.body);
  assert.ok(
    !sent.includes("llama-70b"),
    "the unvalidated model never reaches upstream",
  );
  assert.equal(sent.match(/"model"/g)?.length, 1);
  assert.equal(JSON.parse(sent).model, "qwen3-8b");
});

test("#46 an over-limit key gets 429 before the hub reads its body", async () => {
  const { app } = harness({});
  const send = (body: BodyInit) =>
    app.request(
      new Request(CHAT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit),
    );
  for (let i = 0; i < LLM_LIMITS.burst; i++) {
    assert.equal((await send(JSON.stringify(ask()))).status, 200);
  }
  let pulls = 0;
  // A body that never ends: reading it would hang until the 30 s body timeout.
  const drip = new ReadableStream<Uint8Array>({
    pull(ctl) {
      pulls++;
      if (pulls === 1) ctl.enqueue(new TextEncoder().encode('{"model":'));
      return new Promise(() => {});
    },
  });
  const res = await Promise.race([
    send(drip),
    new Promise<"hung">((r) => setTimeout(() => r("hung"), 500)),
  ]);
  assert.notEqual(res, "hung", "429 without waiting for the body");
  assert.equal((res as Response).status, 429);
  assert.ok(pulls <= 1, "the body is not read past the first pull");
});

test("#46 an over-limit key is refused even when its body is too large", async () => {
  const { chat } = harness({});
  for (let i = 0; i < LLM_LIMITS.burst; i++) {
    assert.equal((await chat(ask())).status, 200);
  }
  const res = await chat(ask({ pad: "x".repeat(LLM_LIMITS.bodyBytes) }));
  assert.equal(res.status, 429);
});

test("#46 a too-large body frees the in-flight slot taken before the read", async () => {
  const { chat, slots } = harness({});
  for (let i = 0; i < LLM_LIMITS.inFlight + 1; i++) {
    const res = await chat(ask({ pad: "x".repeat(LLM_LIMITS.bodyBytes) }));
    assert.equal(res.status, 413);
    assert.equal(slots(), 0);
  }
});

test("#47 upstream 404 without the model name is 502 (misconfigured upstream)", async () => {
  const { chat } = harness({
    reply: () => new Response("404 page not found", { status: 404 }),
  });
  const res = await chat(ask());
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), {
    error: { message: "LLM upstream failed" },
    code: "upstream_error",
    data: { upstream_status: 404 },
  });
});

test("#47 a stalled upstream 404 body is 504 upstream_timeout, not 502", async () => {
  const { clock, fire } = manualClock();
  const { chat, calls, slots, logs } = harness({
    clock,
    reply: ({ init }) => {
      const r = undiciSse(init.signal, ["404 page"]);
      return new Response(r.body, { status: 404 });
    },
  });
  const pending = chat(ask());
  while (calls.length === 0) await tick();
  await tick();
  fire();
  const res = await pending;
  assert.equal(res.status, 504);
  assert.equal((await res.json()).code, "upstream_timeout");
  assert.equal(slots(), 0);
  assert.match(logs.at(-1)!, /"code":"upstream_timeout"/);
});

test("#47 a client leaving during a stalled 404 body logs 408 client_closed", async () => {
  const { clock } = manualClock();
  const client = new AbortController();
  const { chat, calls, slots, logs } = harness({
    clock,
    reply: ({ init }) => {
      const r = undiciSse(init.signal, ["404 page"]);
      return new Response(r.body, { status: 404 });
    },
  });
  const pending = chat(ask(), client.signal);
  while (calls.length === 0) await tick();
  await tick();
  client.abort();
  await pending.catch(() => {});
  await tick();
  assert.equal(slots(), 0);
  assert.match(logs.at(-1)!, /"code":"client_closed"/);
});

test("#47 upstream 404 naming the requested model stays 400 upstream_rejected", async () => {
  const { chat } = harness({
    reply: () =>
      new Response("could not find suitable handler for qwen3-8b", {
        status: 404,
      }),
  });
  const res = await chat(ask());
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "upstream_rejected");
});

test("#47 upstream 429 passes through as 429 with its Retry-After", async () => {
  const { chat } = harness({
    reply: () =>
      new Response("busy", { status: 429, headers: { "retry-after": "30" } }),
  });
  const res = await chat(ask());
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "30");
  const body = await res.json();
  assert.equal(body.code, "rate_limited");
  assert.deepEqual(body.data, { upstream_status: 429 });
});

test("#47 upstream 413 maps to 413 payload_too_large", async () => {
  const { chat } = harness({
    reply: () => new Response("too big", { status: 413 }),
  });
  const res = await chat(ask());
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.code, "payload_too_large");
  assert.deepEqual(body.data, { upstream_status: 413 });
});

test("#50 every relay deadline is under Cloudflare's 100 s origin timeout", async () => {
  const armed: number[] = [];
  const clock: Clock = {
    now: () => 0,
    setTimer(_fn, ms) {
      armed.push(ms);
      return () => {};
    },
  };
  const { chat } = harness({ clock });
  assert.equal((await chat(ask())).status, 200);
  // The upstream deadline itself, not only the 30 s body timer (hub #64).
  assert.ok(armed.includes(LLM_LIMITS.timeoutMs), `armed ${armed}`);
  assert.ok(LLM_LIMITS.timeoutMs < 100_000);
  assert.ok(
    Math.max(...armed) < 100_000,
    `longest deadline ${Math.max(...armed)} ms`,
  );
});

// ---- review findings: hub #58 #59 #60 #62 #65 #68 ----

/** A request body that sends one chunk, then waits; `fail` errors it like a client abort. */
function dripBody() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
      c.enqueue(new TextEncoder().encode('{"model":'));
    },
  });
  return {
    body,
    fail: () => ctl.error(new DOMException("aborted", "AbortError")),
  };
}

function sendStream(app: ReturnType<typeof harness>["app"], body: BodyInit) {
  return app.request(
    new Request(CHAT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit),
  );
}

test("#58 namesModel matches a whole model token, not a substring", () => {
  assert.equal(
    namesModel("could not find suitable handler for qwen3-8b", "qwen3-8b"),
    true,
  );
  assert.equal(
    namesModel('{"error":"model \\"qwen3-8b\\" not found"}', "qwen3-8b"),
    true,
  );
  assert.equal(namesModel("unknown model qwen3-8b.", "qwen3-8b"), true);
  assert.equal(namesModel("404 page not found", "page"), false);
  assert.equal(namesModel("404 page not found", "4"), false);
  assert.equal(namesModel("no handler for qwen3-8b", "qwen3"), false);
  assert.equal(namesModel("no handler for qwen2.5-7b", "qwen2"), false);
  // Upstream JSON-escaped the id; the raw id is not in the body.
  assert.equal(namesModel('{"error":"no model org\\/m\\"x"}', 'org/m"x'), true);
});

test("hub-pr-70 namesModel never throws on a model id too long for a RegExp", () => {
  const long = "a".repeat(40_000);
  assert.equal(namesModel(`no handler for ${long}`, long), true);
  assert.equal(namesModel(`no handler for ${long}b`, long), false);
  assert.equal(namesModel("no handler for qwen3-8b", long), false);
});

test("#81 a model id over 256 chars is 400 invalid_request, upstream never called", async () => {
  const max = "a".repeat(LLM_LIMITS.modelIdChars);
  const { chat, calls } = harness({
    reply: () => new Response(`no handler for ${max}`, { status: 404 }),
  });
  for (const model of [`${max}a`, "a".repeat(40_000)]) {
    const res = await chat(ask({ model }));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "invalid_request");
  }
  assert.equal(calls.length, 0);
  const res = await chat(ask({ model: max }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "upstream_rejected");
});

test("#81 namesModel looks at no more than 64 occurrences", () => {
  const miss = "qwen3-8bx ";
  assert.equal(namesModel(`${miss.repeat(63)}qwen3-8b`, "qwen3-8b"), true);
  assert.equal(namesModel(`${miss.repeat(64)}qwen3-8b`, "qwen3-8b"), false);
});

test("#73 an id after ':' or '/' is a whole token", () => {
  for (const body of [
    "model_not_found:qwen3-8b",
    "/v1/models/qwen3-8b",
    "models/qwen3-8b is not found",
  ]) {
    assert.equal(namesModel(body, "qwen3-8b"), true, body);
  }
  for (const body of [
    "xqwen3-8b",
    "7qwen3-8b",
    "-qwen3-8b",
    "_qwen3-8b",
    ".qwen3-8b",
  ]) {
    assert.equal(namesModel(body, "qwen3-8b"), false, body);
  }
});

test("#83 a JSON body is decoded and its strings are searched", () => {
  const cafe = '{"error":{"message":"model caf\\u00e9 not found"}}';
  assert.equal(namesModel(cafe, "café"), true);
  assert.equal(namesModel(cafe, "caf"), false);
  const qwen = '{"e":"Qwen\\/Qwen3-8B not found"}';
  assert.equal(namesModel(qwen, "Qwen/Qwen3-8B"), true);
  assert.equal(namesModel(qwen, "Qwen"), false);
  // Escapes are decoded before the edges are looked at.
  assert.equal(namesModel('{"error":"line\\nqwen3-8b"}', "qwen3-8b"), true);
  assert.equal(
    namesModel('{"error":"\\u003cqwen3-8b\\u003e"}', "qwen3-8b"),
    true,
  );
  assert.equal(namesModel('{"error":"\\\\nqwen3-8b"}', "qwen3-8b"), false);
  assert.equal(namesModel('{"d":"no \\ud83d\\ude00x"}', "\u{1F600}"), false);
  assert.equal(namesModel('{"d":"no \\ud83d\\ude00"}', "\u{1F600}"), true);
});

test("#83 a model named only in a JSON key matches", () => {
  const body = '{"errors":{"qwen3-8b":"not loaded"}}';
  assert.equal(namesModel(body, "qwen3-8b"), true);
  assert.equal(namesModel(body, "qwen3"), false);
});

test("#83 text bodies keep the whole-token rule", () => {
  assert.equal(namesModel("model_not_found:qwen3-8b", "qwen3-8b"), true);
  assert.equal(namesModel("qwen3-8b...", "qwen3-8b"), true);
  assert.equal(namesModel("qwen3-8b", "qwen3"), false);
  assert.equal(
    namesModel("404 Not Found: no handler for qwen3-8b", "qwen3-8b"),
    true,
  );
  assert.equal(
    namesModel("404 Not Found: no handler for qwen3-8b", "qwen3-8"),
    false,
  );
});

test("#83 a deeply nested JSON body does not throw", () => {
  const deep = (inner: string) => "[".repeat(1000) + inner + "]".repeat(1000);
  assert.doesNotThrow(() => namesModel(deep('"qwen3-8b"'), "qwen3-8b"));
  // Past the depth cap nothing is searched.
  assert.equal(namesModel(deep('"qwen3-8b"'), "qwen3-8b"), false);
  // A shallow mention next to deep nesting is still found.
  const body = `{"deep":${deep("1")},"error":"no handler for qwen3-8b"}`;
  assert.equal(namesModel(body, "qwen3-8b"), true);
});

test("#83 a truncated text body cut right after the id does not match", () => {
  assert.equal(namesModel("no handler for qwen3-8b", "qwen3-8b", true), false);
  assert.equal(
    namesModel('{"error":"no handler for qwen3-8b', "qwen3-8b", true),
    false,
  );
  assert.equal(
    namesModel('{"error":"no handler for qwen3-8b"', "qwen3-8b", true),
    true,
  );
});

test("#75 an ellipsis or doubled period after the id still matches", () => {
  assert.equal(namesModel("no handler for qwen3-8b...", "qwen3-8b"), true);
  assert.equal(namesModel("no handler for qwen3-8b..", "qwen3-8b"), true);
  assert.equal(namesModel("no handler for qwen3-8b:: x", "qwen3-8b"), true);
  assert.equal(namesModel("no handler for qwen3..5", "qwen3"), false);
  assert.equal(namesModel("no handler for qwen3::x", "qwen3"), false);
});

test("#80 a match running into a cut body does not count", () => {
  assert.equal(namesModel("no handler for qwen3", "qwen3", true), false);
  assert.equal(namesModel("no handler for qwen3..", "qwen3", true), false);
  assert.equal(namesModel("no handler for qwen3 x", "qwen3", true), true);
  assert.equal(namesModel("no handler for qwen3", "qwen3", false), true);
});

// The cap falls just after `model`, or after the first of the two bytes of "é".
for (const [model, tail, split] of [
  ["qwen3", "qwen3-8b", 0],
  ["caf", "café", 1],
] as const) {
  test(`#80 a 404 cut at 64 KiB inside "${tail}" is 502 for model ${model}`, async () => {
    const enc = new TextEncoder();
    const head = enc.encode(`no handler for ${tail}`);
    const read = enc.encode(`no handler for ${model}`).length + split;
    const pad = enc.encode("x".repeat(LLM_LIMITS.notFoundBodyBytes - read));
    const { chat } = harness({
      reply: () =>
        new Response(new Blob([pad, head, enc.encode(" not found")]), {
          status: 404,
        }),
    });
    const res = await chat(ask({ model }));
    assert.equal(res.status, 502);
    assert.equal((await res.json()).code, "upstream_error");
  });
}

// A body of exactly 64 KiB is whole, so an id at its very end still counts;
// one byte more and the first 64 KiB is a cut body again (#90).
for (const [extra, status, code] of [
  ["", 400, "upstream_rejected"],
  [" ", 502, "upstream_error"],
] as const) {
  test(`#90 a 404 of 64 KiB + ${extra.length} ending in the id is ${status}`, async () => {
    const enc = new TextEncoder();
    const head = enc.encode("no handler for qwen3-8b");
    const pad = enc.encode(
      "x".repeat(LLM_LIMITS.notFoundBodyBytes - head.length),
    );
    const { chat } = harness({
      reply: () =>
        new Response(new Blob([pad, head, enc.encode(extra)]), {
          status: 404,
        }),
    });
    const res = await chat(ask({ model: "qwen3-8b" }));
    assert.equal(res.status, status);
    assert.equal((await res.json()).code, code);
  });
}

test("#58 a 404 page not found is 502 even for a model named page", async () => {
  const { chat } = harness({
    reply: () => new Response("404 page not found", { status: 404 }),
  });
  const res = await chat(ask({ model: "page" }));
  assert.equal(res.status, 502);
  assert.equal((await res.json()).code, "upstream_error");
});

test("#59 an endless upstream 404 body is read only to 64 KiB", async () => {
  let pulled = 0;
  const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
  const { chat } = harness({
    reply: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(ctl) {
            ctl.enqueue(new TextEncoder().encode("no handler for qwen3-8b "));
          },
          pull(ctl) {
            pulled += chunk.length;
            ctl.enqueue(chunk);
          },
        }),
        { status: 404 },
      ),
  });
  const res = await chat(ask());
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "upstream_rejected");
  assert.ok(
    pulled <= LLM_LIMITS.notFoundBodyBytes + 2 * chunk.length,
    `pulled ${pulled}`,
  );
});

test("#60 #76 upstreamRetryAfter holds whole seconds and an HTTP date to 1..3600, else 1", () => {
  const now = Date.parse("Wed, 30 Sep 2026 12:00:00 GMT");
  assert.equal(upstreamRetryAfter("30", now), "30");
  assert.equal(upstreamRetryAfter("0", now), "1");
  assert.equal(upstreamRetryAfter("3600", now), "3600");
  assert.equal(upstreamRetryAfter("86400", now), "3600");
  assert.equal(upstreamRetryAfter("9".repeat(400), now), "3600");
  assert.equal(upstreamRetryAfter(null, now), "1");
  for (const bad of ["", "-5", "1.5", "soon", "30s"]) {
    assert.equal(upstreamRetryAfter(bad, now), "1", bad);
  }
  assert.equal(upstreamRetryAfter("Wed, 30 Sep 2026 12:00:42 GMT", now), "42");
  assert.equal(upstreamRetryAfter("Wed, 30 Sep 2026 11:00:00 GMT", now), "1");
  assert.equal(
    upstreamRetryAfter("Thu, 01 Oct 2026 12:00:00 GMT", now),
    "3600",
  );
});

test("#60 an upstream 429 with a garbage Retry-After sends 1", async () => {
  const { chat } = harness({
    reply: () =>
      new Response("busy", {
        status: 429,
        headers: { "retry-after": "later" },
      }),
  });
  const res = await chat(ask());
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "1");
});

test("#62 #65 a body read timeout frees the slot and logs request_timeout", async () => {
  const { clock, fire } = manualClock();
  const { app, slots, logs } = harness({ clock });
  const drip = dripBody();
  const pending = sendStream(app, drip.body);
  while (slots() === 0) await tick();
  await tick();
  fire();
  const res = await pending;
  assert.equal(res.status, 408);
  assert.equal((await res.json()).code, "request_timeout");
  assert.equal(slots(), 0);
  assert.match(logs.at(-1)!, /"status":408,"code":"request_timeout"/);
});

test("#62 #65 a client abort mid-upload frees the slot and logs client_closed, not a 500", async () => {
  const { clock } = manualClock();
  const { app, slots, logs, calls } = harness({ clock });
  const drip = dripBody();
  const pending = sendStream(app, drip.body);
  while (slots() === 0) await tick();
  await tick();
  drip.fail();
  const res = await pending;
  assert.notEqual(res.status, 500);
  assert.equal(slots(), 0);
  assert.equal(calls.length, 0);
  assert.match(logs.at(-1)!, /"status":408,"code":"client_closed"/);
});

test("#62 a too-large body logs payload_too_large", async () => {
  const { chat, logs } = harness({});
  const res = await chat(ask({ pad: "x".repeat(LLM_LIMITS.bodyBytes) }));
  assert.equal(res.status, 413);
  assert.match(logs.at(-1)!, /"status":413,"code":"payload_too_large"/);
});

test("#68 #77 models: upstream 429 maps like chat; 413, 404 and 400 are 502", async () => {
  const cases: [Response, number, string, string | null][] = [
    [
      new Response("", { status: 429, headers: { "retry-after": "7" } }),
      429,
      "rate_limited",
      "7",
    ],
    [
      new Response("", { status: 429, headers: { "retry-after": "x" } }),
      429,
      "rate_limited",
      "1",
    ],
    [new Response("", { status: 413 }), 502, "upstream_error", null],
    [
      new Response("model qwen3-8b", { status: 404 }),
      502,
      "upstream_error",
      null,
    ],
    [new Response("", { status: 400 }), 502, "upstream_error", null],
  ];
  for (const [reply, status, code, retryAfter] of cases) {
    const { app } = harness({ reply: () => reply });
    const res = await app.request(MODELS);
    assert.equal(res.status, status);
    assert.equal(res.headers.get("retry-after"), retryAfter);
    const body = await res.json();
    assert.equal(body.code, code);
    assert.equal(body.data.upstream_status, reply.status);
  }
});
