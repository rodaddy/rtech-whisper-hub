/**
 * The LLM relay (docs/protocol.md section 11): an OpenAI-compatible
 * chat-completions pass-through to an upstream llama-swap host.
 *
 *   POST /llm/v1/chat/completions  body passed through; stream:true relays SSE
 *   GET  /llm/v1/models            upstream /v1/models passed through
 *
 * Mounted under /api, behind the device-key auth. Prompts and completions
 * live only in memory and are never logged.
 */
import { Hono, type Context } from "hono";
import type { Logger } from "pino";
import type { Config } from "../config.ts";
import { readBody } from "../voice/bodyTimeout.ts";
import {
  type Clock,
  type InFlight,
  type TokenBucket,
  systemClock,
} from "../voice/limits.ts";

export const LLM_CHAT_PATH = "/llm/v1/chat/completions";
export const LLM_MODELS_PATH = "/llm/v1/models";
const ROUTE = "llm";

/** v1 starting values (protocol 11.3). */
export const LLM_LIMITS = {
  perMinute: 60,
  burst: 10,
  inFlight: 2,
  bodyBytes: 1024 * 1024,
  /**
   * Whole-request bound for a non-stream call, and time to first byte for a
   * stream. Kept under the 100 s origin timeout common on reverse proxies, so
   * a slow upstream gets the hub's 504 and not a proxy's own timeout page.
   */
  timeoutMs: 90_000,
  /** Longest gap between two chunks of a stream. */
  streamIdleMs: 60_000,
  /** The models list is small and cheap. */
  modelsTimeoutMs: 15_000,
  /** How much of an upstream 404 body is read to look for the model. */
  notFoundBodyBytes: 64 * 1024,
  /** Longest model id the chat route accepts, in UTF-16 units. */
  modelIdChars: 256,
  /** Longest upstream Retry-After the hub passes on, in seconds. */
  retryAfterMaxSeconds: 3600,
} as const;

/** The resolved upstream: `url` is undefined when the relay is not configured. */
export interface LlmUpstream {
  url: string | undefined;
  apiKey: string | undefined;
  /** Empty means every model is allowed. */
  allowlist: readonly string[];
}

/**
 * LLM_UPSTREAM_URL wins. When it is unset the relay reuses VOICE_UPSTREAM_URL:
 * both are llama-swap's root, which serves the OpenAI /v1/* API, and then the
 * voice key goes with it. A separate LLM URL never inherits the voice key.
 */
export function resolveLlmUpstream(
  config: Pick<
    Config,
    | "VOICE_UPSTREAM_URL"
    | "VOICE_UPSTREAM_API_KEY"
    | "LLM_UPSTREAM_URL"
    | "LLM_UPSTREAM_API_KEY"
    | "LLM_MODEL_ALLOWLIST"
  >,
): LlmUpstream {
  const own = config.LLM_UPSTREAM_URL;
  return {
    url: own ?? config.VOICE_UPSTREAM_URL,
    apiKey:
      config.LLM_UPSTREAM_API_KEY ??
      (own ? undefined : config.VOICE_UPSTREAM_API_KEY),
    allowlist: parseAllowlist(config.LLM_MODEL_ALLOWLIST),
  };
}

export function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface LlmDeps {
  upstream: LlmUpstream;
  logger: Pick<Logger, "info">;
  fetch: typeof globalThis.fetch;
  clock?: Clock;
  limiters: {
    rate: Pick<TokenBucket, "take">;
    inFlight: Pick<InFlight, "acquire">;
  };
  getDeviceId(c: Context): string;
}

type Status = 400 | 401 | 408 | 413 | 429 | 502 | 503 | 504;

function envelope(
  code: string,
  message: string,
  data?: Record<string, unknown>,
) {
  return { error: { message }, code, ...(data ? { data } : {}) };
}

class RelayError extends Error {
  readonly status: Status;
  readonly code: string;
  readonly data?: Record<string, unknown>;
  constructor(
    status: Status,
    code: string,
    message: string,
    data?: Record<string, unknown>,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

/** An id character other than "." and ":", which may also end a sentence. */
const ID_TAIL = String.raw`[\p{L}\p{N}_/@+\-]`;
/**
 * What may not come just before a match (one code point, maybe a pair): a
 * letter, digit, "_", ".", "-", "@" or "+". A ":" or "/" may ("models/x",
 * "model_not_found:x"), so "x" is found in "org/x" too.
 */
const ID_BEFORE = /[\p{L}\p{N}_.@+\-]$/u;
/** What may not follow a match: an id character, or "."s/":"s and one. */
const ID_AFTER = new RegExp(`(?:${ID_TAIL}|[.:]+${ID_TAIL})`, "uy");
/** Only "."s and ":"s up to the end of the text. */
const DOTS_TO_END = /[.:]*$/y;
/** Occurrences of the id namesModel looks at before giving up. */
const MAX_OCCURRENCES = 64;
/** Nesting namesModel walks into in a JSON body. */
const MAX_JSON_DEPTH = 32;
/** Strings (values and keys) namesModel collects from a JSON body. */
const MAX_JSON_STRINGS = 10_000;

/**
 * Every string value and object key in `value`, in document order, down to
 * MAX_JSON_DEPTH levels and at most MAX_JSON_STRINGS of them. Iterative, so
 * a deeply nested body cannot overflow the stack.
 */
function jsonStrings(value: unknown): string[] {
  const out: string[] = [];
  const stack: [unknown, number][] = [[value, 0]];
  while (stack.length > 0 && out.length < MAX_JSON_STRINGS) {
    const [v, depth] = stack.pop()!;
    if (typeof v === "string") {
      out.push(v);
    } else if (typeof v === "object" && v !== null && depth < MAX_JSON_DEPTH) {
      const kids: [unknown, number][] = [];
      if (Array.isArray(v)) {
        for (const x of v) kids.push([x, depth + 1]);
      } else {
        for (const [k, x] of Object.entries(v)) {
          kids.push([k, depth + 1], [x, depth + 1]);
        }
      }
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
    }
  }
  return out;
}

/**
 * Whether `text` holds `model` as a whole token, looking at no more than
 * `budget.left` occurrences in all. The id is found with indexOf and only its
 * edges go through a regex: a RegExp built from a client-supplied id throws
 * once the id passes 32767 chars. The shared cap keeps a
 * periodic body from making the scan quadratic.
 */
function tokenIn(
  text: string,
  model: string,
  truncated: boolean,
  budget: { left: number },
): boolean {
  for (let i = text.indexOf(model); i !== -1; i = text.indexOf(model, i + 1)) {
    if (budget.left-- <= 0) return false;
    const end = i + model.length;
    ID_AFTER.lastIndex = end;
    DOTS_TO_END.lastIndex = end;
    if (
      !ID_BEFORE.test(text.slice(Math.max(0, i - 2), i)) &&
      !ID_AFTER.test(text) &&
      !(truncated && DOTS_TO_END.test(text))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether an upstream 404 body names `model` as a whole token: "qwen3" does
 * not match inside "qwen3-8b", and "4" not inside "404". A trailing "." or
 * ":" still ends the token ("... qwen3-8b.", "qwen3-8b..."). A JSON body is
 * decoded and its string values and keys are searched, so JSON escapes are
 * JSON.parse's business; any other body is searched as text. The
 * router's bare "404 page not found" names no model, whatever the id.
 * `truncated` says the body was cut at the read cap: it is searched as text,
 * and a match running into the cut does not count.
 */
export function namesModel(
  body: string,
  model: string,
  truncated = false,
): boolean {
  if (model === "" || body.trim() === "404 page not found") return false;
  const budget = { left: MAX_OCCURRENCES };
  if (!truncated) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return tokenIn(body, model, false, budget);
    }
    return jsonStrings(parsed).some((s) => tokenIn(s, model, false, budget));
  }
  return tokenIn(body, model, true, budget);
}

/**
 * The Retry-After to pass on from an upstream 429: whole seconds as
 * held to 1..3600, an IMF-fixdate turned into seconds from now and
 * held the same way, else "1".
 */
export function upstreamRetryAfter(raw: string | null, nowMs: number): string {
  const v = raw?.trim() ?? "";
  const clamp = (secs: number) =>
    String(Math.min(LLM_LIMITS.retryAfterMaxSeconds, Math.max(1, secs)));
  if (/^\d+$/.test(v)) return clamp(Number(v));
  if (
    /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(v)
  ) {
    const at = Date.parse(v);
    if (Number.isFinite(at)) {
      return clamp(Math.ceil((at - nowMs) / 1000));
    }
  }
  return "1";
}

/**
 * Upstream non-2xx (protocol 11.4). A 400/422, or a 404 whose body names the
 * requested model (`namedModel`), is the request's fault (bad messages, an
 * unknown model, a context overflow): 400 upstream_rejected, do not retry.
 * Any other 404 means the upstream URL is wrong, so it is the upstream's
 * fault like everything else: 502. 413 and 429 keep their meaning; a 429
 * carries upstream's Retry-After.
 */
function upstreamStatusError(status: number, namedModel: boolean): RelayError {
  const data = { upstream_status: status };
  if (status === 400 || status === 422 || (status === 404 && namedModel)) {
    return new RelayError(
      400,
      "upstream_rejected",
      "LLM upstream rejected the request",
      data,
    );
  }
  if (status === 413) {
    return new RelayError(
      413,
      "payload_too_large",
      "LLM upstream refused the request size",
      data,
    );
  }
  if (status === 429) {
    return new RelayError(429, "rate_limited", "LLM upstream is busy", data);
  }
  return new RelayError(502, "upstream_error", "LLM upstream failed", data);
}

/** An AbortController that fires after `ms`; `reset` restarts the countdown. */
function deadline(clock: Clock, ms: number) {
  const ctl = new AbortController();
  let cancel = clock.setTimer(() => ctl.abort(), ms);
  return {
    signal: ctl.signal,
    abort: () => ctl.abort(),
    reset(nextMs: number) {
      cancel();
      cancel = clock.setTimer(() => ctl.abort(), nextMs);
    },
    stop: () => cancel(),
  };
}

/** Rejects with an AbortError once `signal` aborts; `off` removes the listener. */
function abortRace(signal: AbortSignal) {
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException("timeout", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {});
  return { aborted, off: () => signal.removeEventListener("abort", onAbort) };
}

/**
 * Reads at most `max` bytes of the body as text, then cancels the rest.
 * `truncated` says the body is longer than `max`; a character cut at the cap
 * is dropped, not decoded as U+FFFD.
 */
async function readHead(
  res: Response,
  signal: AbortSignal,
  max: number,
): Promise<{ text: string; truncated: boolean }> {
  if (signal.aborted) throw new DOMException("timeout", "AbortError");
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const race = abortRace(signal);
  const dec = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    // Read one byte past `max`, so a body of exactly `max` bytes is seen to
    // end and is not reported as truncated.
    while (size <= max) {
      const step = await Promise.race([reader.read(), race.aborted]);
      if (step.done) return { text: text + dec.decode(), truncated: false };
      const part = step.value.subarray(0, Math.max(0, max - size));
      size += step.value.length;
      text += dec.decode(part, { stream: true });
    }
    return { text, truncated: true };
  } finally {
    race.off();
    reader.cancel().catch(() => {});
  }
}

/** Reads the body to text, racing the abort signal (a fake clock cannot abort a real body read). */
async function readText(res: Response, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new DOMException("timeout", "AbortError");
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException("timeout", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([res.text(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function isAbort(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "TimeoutError")
  );
}

const SSE_TIMEOUT_EVENT = new TextEncoder().encode(
  `data: ${JSON.stringify(envelope("upstream_timeout", "LLM upstream stream went idle"))}\n\n`,
);

export function llmRoutes(deps: LlmDeps) {
  const { upstream, logger, limiters } = deps;
  const clock = deps.clock ?? systemClock;
  const base = upstream.url;
  const chatUrl = base
    ? new URL("/v1/chat/completions", base).toString()
    : undefined;
  const modelsUrl = base ? new URL("/v1/models", base).toString() : undefined;
  const allow = new Set(upstream.allowlist);
  const app = new Hono();

  const headers = (json: boolean): Record<string, string> => {
    const h: Record<string, string> = {
      accept: json ? "application/json" : "text/event-stream",
    };
    if (json) h["content-type"] = "application/json";
    if (upstream.apiKey) h.authorization = `Bearer ${upstream.apiKey}`;
    return h;
  };

  /** The Retry-After header for an upstream 429, per protocol 11.4. */
  const upstreamRetry = (res: Response) =>
    res.status === 429
      ? {
          "Retry-After": upstreamRetryAfter(
            res.headers.get("retry-after"),
            clock.now(),
          ),
        }
      : undefined;

  /** Rate bucket then the in-flight cap; a release, or the 429 to send. */
  const admit = (
    deviceId: string,
  ): { release: () => void } | { error: RelayError; retryAfter: string } => {
    const taken = limiters.rate.take(deviceId, ROUTE);
    if (!taken.ok) {
      return {
        error: new RelayError(429, "rate_limited", "LLM rate limit exceeded"),
        retryAfter: String(taken.retryAfterSeconds),
      };
    }
    const release = limiters.inFlight.acquire(deviceId, ROUTE);
    if (!release) {
      return {
        error: new RelayError(
          429,
          "rate_limited",
          "too many LLM requests in flight",
        ),
        retryAfter: "1",
      };
    }
    return { release };
  };

  // Run inside the handler, after admission, so an over-limit key is refused
  // before the hub buffers up to 1 MB of its body.
  const bodyReader = readBody({
    maxSize: LLM_LIMITS.bodyBytes,
    clock,
    onTooLarge: (c) =>
      c.json(
        envelope("payload_too_large", "LLM request body exceeds 1 MB"),
        413,
      ),
    onTimeout: (c) =>
      c.json(
        envelope("request_timeout", "request body not received within 30 s"),
        408,
      ),
  });

  app.post(LLM_CHAT_PATH, async (c) => {
    const started = clock.now();
    const deviceId = deps.getDeviceId(c);
    const log: Record<string, unknown> = {
      device_id: deviceId,
      route: "llm_chat",
    };
    const done = (status: number, code?: string) =>
      logger.info(
        {
          ...log,
          status,
          ...(code ? { code } : {}),
          duration_ms: clock.now() - started,
        },
        "llm relay",
      );
    const fail = (e: RelayError, extra?: Record<string, string>) => {
      done(e.status, e.code);
      return c.json(envelope(e.code, e.message, e.data), e.status, extra);
    };

    if (!chatUrl) {
      return fail(
        new RelayError(503, "upstream_unavailable", "LLM relay not configured"),
      );
    }
    const admitted = admit(deviceId);
    if ("error" in admitted) {
      return fail(admitted.error, { "Retry-After": admitted.retryAfter });
    }
    let release: (() => void) | null = admitted.release;
    try {
      let read = false;
      let refused: Response | void;
      try {
        refused = await bodyReader(c, async () => {
          read = true;
        });
      } catch {
        // The client went away mid-upload: the body read throws.
        return fail(
          new RelayError(408, "client_closed", "client closed the request"),
        );
      }
      if (!read) {
        const res = refused as Response;
        done(
          res.status,
          res.status === 413 ? "payload_too_large" : "request_timeout",
        );
        return res;
      }
      const text = await c.req.text();
      log.bytes_in = Buffer.byteLength(text);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return fail(
          new RelayError(400, "invalid_request", "body must be JSON"),
        );
      }
      if (
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body) ||
        typeof (body as { model?: unknown }).model !== "string" ||
        (body as { model: string }).model.length === 0 ||
        (body as { model: string }).model.length > LLM_LIMITS.modelIdChars ||
        !Array.isArray((body as { messages?: unknown }).messages)
      ) {
        return fail(
          new RelayError(
            400,
            "invalid_request",
            `model must be a non-empty string of at most ${LLM_LIMITS.modelIdChars} chars and messages an array`,
          ),
        );
      }
      const model = (body as { model: string }).model;
      const stream = (body as { stream?: unknown }).stream === true;
      log.model = model;
      log.stream = stream;
      if (allow.size > 0 && !allow.has(model)) {
        return fail(
          new RelayError(
            400,
            "model_not_allowed",
            "model is not on the hub allowlist",
          ),
        );
      }

      // The client going away aborts the upstream call and frees the slot:
      // @hono/node-server only wires close->cancel after writeHead, so a
      // client that leaves before upstream answers is seen only here.
      const client = c.req.raw.signal;
      const dl = deadline(clock, LLM_LIMITS.timeoutMs);
      const signal = AbortSignal.any([dl.signal, client]);
      // Nobody receives this reply; it exists so the log line is right.
      const clientGone = () =>
        fail(new RelayError(408, "client_closed", "client closed the request"));
      let res: Response;
      try {
        res = await deps.fetch(chatUrl, {
          method: "POST",
          // Always JSON: llama-swap reads the model id only from a JSON body.
          headers: {
            ...headers(!stream),
            "content-type": "application/json",
          },
          // Re-serialised, not the client's bytes: a body with two "model"
          // keys forwards only the one validated above. Every
          // field still reaches upstream.
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        dl.stop();
        if (client.aborted) return clientGone();
        return isAbort(err)
          ? fail(
              new RelayError(504, "upstream_timeout", "LLM upstream timed out"),
            )
          : fail(
              new RelayError(
                503,
                "upstream_unavailable",
                "LLM upstream unreachable",
              ),
            );
      }
      log.upstream_status = res.status;
      if (!res.ok) {
        // Only a 404's body matters: it tells an unknown model from a wrong URL.
        let why = { text: "", truncated: false };
        if (res.status === 404) {
          try {
            why = await readHead(res, signal, LLM_LIMITS.notFoundBodyBytes);
          } catch (err) {
            // A stalled 404 body is still a deadline or a departed client,
            // not a misconfigured upstream (11.4).
            dl.stop();
            if (client.aborted) return clientGone();
            if (isAbort(err))
              return fail(
                new RelayError(
                  504,
                  "upstream_timeout",
                  "LLM upstream timed out",
                ),
              );
          }
        } else {
          await res.body?.cancel().catch(() => {});
        }
        dl.stop();
        return fail(
          upstreamStatusError(
            res.status,
            res.status === 404 && namesModel(why.text, model, why.truncated),
          ),
          upstreamRetry(res),
        );
      }

      if (!stream) {
        let out: string;
        try {
          out = await readText(res, signal);
        } catch (err) {
          if (client.aborted) return clientGone();
          return isAbort(err)
            ? fail(
                new RelayError(
                  504,
                  "upstream_timeout",
                  "LLM upstream timed out",
                ),
              )
            : fail(
                new RelayError(
                  502,
                  "upstream_error",
                  "LLM upstream reply was cut off",
                  { upstream_status: res.status },
                ),
              );
        } finally {
          dl.stop();
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(out);
        } catch {
          parsed = null;
        }
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          !Array.isArray((parsed as { choices?: unknown }).choices)
        ) {
          return fail(
            new RelayError(
              502,
              "upstream_error",
              "LLM upstream reply was not a chat completion",
              {
                upstream_status: res.status,
              },
            ),
          );
        }
        log.bytes_out = Buffer.byteLength(out);
        done(200);
        return c.body(out, 200, { "content-type": "application/json" });
      }

      const type = res.headers.get("content-type") ?? "";
      if (!res.body || !type.startsWith("text/event-stream")) {
        dl.stop();
        await res.body?.cancel().catch(() => {});
        return fail(
          new RelayError(
            502,
            "upstream_error",
            "LLM upstream did not stream server-sent events",
            {
              upstream_status: res.status,
            },
          ),
        );
      }

      // Stream: headers are in, so the whole-request deadline stops and an
      // idle timer takes over. The idle timer has its own timer, not the
      // fetch signal (aborting that errors the body before the timeout event
      // can be sent), and it runs only while a read of upstream is pending,
      // so a slow reader on the client side never counts as upstream idle.
      // The in-flight slot is released the moment the stream ends, goes
      // idle, or the client goes away -- never deferred to a later pull.
      dl.stop();
      const reader = res.body.getReader();
      const finish = release;
      release = null;
      let bytesOut = 0;
      let ended = false;
      let stopIdle = () => {};
      let ctl!: ReadableStreamDefaultController<Uint8Array>;
      const close = (last?: Uint8Array) => {
        try {
          if (last) ctl.enqueue(last);
          ctl.close();
        } catch {
          // already closed or cancelled
        }
      };
      const onClientAbort = () => {
        close();
        end("client_closed");
      };
      const end = (code?: string) => {
        if (ended) return;
        ended = true;
        stopIdle();
        client.removeEventListener("abort", onClientAbort);
        reader.cancel().catch(() => {});
        finish();
        log.bytes_out = bytesOut;
        done(200, code);
      };
      const relay = new ReadableStream<Uint8Array>({
        start(c) {
          ctl = c;
        },
        async pull() {
          if (ended) return;
          stopIdle = clock.setTimer(() => {
            if (ended) return;
            close(SSE_TIMEOUT_EVENT);
            end("upstream_timeout");
          }, LLM_LIMITS.streamIdleMs);
          let step: ReadableStreamReadResult<Uint8Array>;
          try {
            step = await reader.read();
          } catch {
            if (ended) return;
            close();
            end("upstream_error");
            return;
          } finally {
            stopIdle();
          }
          if (ended) return;
          if (step.done) {
            close();
            end();
            return;
          }
          bytesOut += step.value.length;
          ctl.enqueue(step.value);
        },
        cancel() {
          end("client_closed");
        },
      });
      if (client.aborted) {
        onClientAbort();
      } else {
        client.addEventListener("abort", onClientAbort, { once: true });
      }
      return new Response(relay, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "x-accel-buffering": "no",
        },
      });
    } finally {
      release?.();
    }
  });

  app.get(LLM_MODELS_PATH, async (c) => {
    const started = clock.now();
    const deviceId = deps.getDeviceId(c);
    const log: Record<string, unknown> = {
      device_id: deviceId,
      route: "llm_models",
    };
    const fail = (e: RelayError, extra?: Record<string, string>) => {
      logger.info(
        {
          ...log,
          status: e.status,
          code: e.code,
          duration_ms: clock.now() - started,
        },
        "llm relay",
      );
      return c.json(envelope(e.code, e.message, e.data), e.status, extra);
    };
    if (!modelsUrl) {
      return fail(
        new RelayError(503, "upstream_unavailable", "LLM relay not configured"),
      );
    }
    const taken = limiters.rate.take(deviceId, ROUTE);
    if (!taken.ok) {
      return fail(
        new RelayError(429, "rate_limited", "LLM rate limit exceeded"),
        {
          "Retry-After": String(taken.retryAfterSeconds),
        },
      );
    }
    const dl = deadline(clock, LLM_LIMITS.modelsTimeoutMs);
    try {
      let res: Response;
      try {
        res = await deps.fetch(modelsUrl, {
          headers: headers(true),
          signal: dl.signal,
        });
      } catch (err) {
        return isAbort(err)
          ? fail(
              new RelayError(504, "upstream_timeout", "LLM upstream timed out"),
            )
          : fail(
              new RelayError(
                503,
                "upstream_unavailable",
                "LLM upstream unreachable",
              ),
            );
      }
      log.upstream_status = res.status;
      if (!res.ok) {
        // 429 maps as on chat; anything else is 502, a 413 too:
        // a GET has no body to be too large.
        await res.body?.cancel().catch(() => {});
        return fail(
          res.status === 429
            ? upstreamStatusError(res.status, false)
            : new RelayError(502, "upstream_error", "LLM upstream failed", {
                upstream_status: res.status,
              }),
          upstreamRetry(res),
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readText(res, dl.signal));
      } catch (err) {
        if (isAbort(err))
          return fail(
            new RelayError(504, "upstream_timeout", "LLM upstream timed out"),
          );
        parsed = null;
      }
      const data = (parsed as { data?: unknown } | null)?.data;
      if (!Array.isArray(data)) {
        return fail(
          new RelayError(
            502,
            "upstream_error",
            "LLM upstream models reply was malformed",
            {
              upstream_status: res.status,
            },
          ),
        );
      }
      // With an allowlist, list only the models a client may actually use.
      const listed =
        allow.size > 0
          ? {
              ...(parsed as object),
              data: data.filter(
                (m: unknown) =>
                  typeof (m as { id?: unknown })?.id === "string" &&
                  allow.has((m as { id: string }).id),
              ),
            }
          : parsed;
      logger.info(
        { ...log, status: 200, duration_ms: clock.now() - started },
        "llm relay",
      );
      return c.json(listed, 200);
    } finally {
      dl.stop();
    }
  });

  return app;
}
