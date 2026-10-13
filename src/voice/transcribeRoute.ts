// POST /voice/v1/audio/transcriptions: the hub's speech-to-text relay
// (docs/protocol.md 10.1, 10.3-10.6). Mounted under /api behind device auth,
// so the caller supplies getDeviceId. Audio, transcripts and prompts live only
// in memory for the request and never reach the log.

import { type Context, Hono } from "hono";
import type { Logger } from "pino";
import type { Config } from "../config.ts";
import {
  mergeChunkTexts,
  collapseRepeatedSentences,
  splitPcm,
} from "./chunk.ts";
import {
  type Clock,
  type InFlight,
  type Release,
  type Semaphore,
  systemClock,
  type TokenBucket,
} from "./limits.ts";
import { readBody } from "./bodyTimeout.ts";
import { trimSilence } from "./trim.ts";
import { isSpeechWav, makePcmWav, parseWav } from "./wav.ts";

export const TRANSCRIBE_PATH = "/voice/v1/audio/transcriptions";
export const MAX_BODY_BYTES = 25 * 1024 * 1024;
export const CHUNK_TIMEOUT_MS = 60_000;
export const REQUEST_TIMEOUT_MS = 180_000;
const ALLOWED_MODEL = "whisper-large-v3-turbo";
const MAX_PROMPT_CHARS = 1000;
const ROUTE = "transcription";

export interface TranscribeLimiters {
  bucket: TokenBucket;
  inFlight: InFlight;
  semaphore: Semaphore;
}

export interface TranscribeDeps {
  config: Pick<
    Config,
    "VOICE_UPSTREAM_URL" | "VOICE_UPSTREAM_API_KEY" | "VOICE_STT_MODEL"
  >;
  logger: Logger;
  fetch?: typeof fetch;
  clock?: Clock;
  limiters: TranscribeLimiters;
  getDeviceId(c: Context): string;
}

type ErrorCode =
  | "invalid_request"
  | "request_timeout"
  | "model_not_allowed"
  | "payload_too_large"
  | "unsupported_audio_format"
  | "rate_limited"
  | "upstream_error"
  | "upstream_busy"
  | "upstream_unavailable"
  | "upstream_timeout";

class RelayError extends Error {
  readonly status: 400 | 408 | 413 | 415 | 429 | 502 | 503 | 504;
  readonly code: ErrorCode;
  readonly data?: Record<string, unknown>;
  readonly retryAfter?: number;
  constructor(
    status: RelayError["status"],
    code: ErrorCode,
    message: string,
    data?: Record<string, unknown>,
    retryAfter?: number,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
    this.retryAfter = retryAfter;
  }
}

function errorResponse(c: Context, e: RelayError): Response {
  if (e.retryAfter !== undefined) c.header("Retry-After", String(e.retryAfter));
  return c.json(
    {
      error: { message: e.message },
      code: e.code,
      ...(e.data ? { data: e.data } : {}),
    },
    e.status,
  );
}

interface LogFields {
  bytes?: number;
  original_ms?: number;
  kept_ms?: number;
  chunks?: number;
  upstream_status?: number;
}

export function transcribeRoutes(deps: TranscribeDeps) {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const clock = deps.clock ?? systemClock;
  const { bucket, inFlight, semaphore } = deps.limiters;
  const upstreamUrl = new URL(
    "/v1/audio/transcriptions",
    deps.config.VOICE_UPSTREAM_URL,
  ).toString();
  const app = new Hono();

  app.post(
    TRANSCRIBE_PATH,
    readBody({
      maxSize: MAX_BODY_BYTES,
      clock,
      onTooLarge: (c) =>
        errorResponse(
          c,
          new RelayError(413, "payload_too_large", "audio body exceeds 25 MB"),
        ),
      onTimeout: (c) =>
        errorResponse(
          c,
          new RelayError(
            408,
            "request_timeout",
            "request body not received within 30 s",
          ),
        ),
    }),
    async (c) => {
      const started = clock.now();
      const deviceId = deps.getDeviceId(c);
      const log: LogFields = {};
      const releases: Release[] = [];
      let res: Response;
      try {
        res = await handle(c, deviceId, log, releases);
      } catch (err) {
        if (!(err instanceof RelayError)) throw err;
        res = errorResponse(c, err);
      } finally {
        for (const release of releases) release();
      }
      deps.logger.info(
        {
          device_id: deviceId,
          route: ROUTE,
          status: res.status,
          ...log,
          duration_ms: clock.now() - started,
        },
        "voice transcription",
      );
      return res;
    },
  );

  async function handle(
    c: Context,
    deviceId: string,
    log: LogFields,
    releases: Release[],
  ): Promise<Response> {
    const taken = bucket.take(deviceId, ROUTE);
    if (!taken.ok) {
      throw new RelayError(
        429,
        "rate_limited",
        "rate limit exceeded",
        undefined,
        taken.retryAfterSeconds,
      );
    }
    const release = inFlight.acquire(deviceId, ROUTE);
    if (!release) {
      throw new RelayError(
        429,
        "rate_limited",
        "too many requests in flight",
        undefined,
        1,
      );
    }
    releases.push(release);

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      throw new RelayError(
        400,
        "invalid_request",
        "body must be multipart/form-data",
      );
    }
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new RelayError(400, "invalid_request", "file is required");
    }
    const model = optionalString(form, "model");
    if (model !== undefined && model !== ALLOWED_MODEL) {
      throw new RelayError(
        400,
        "model_not_allowed",
        `model must be ${ALLOWED_MODEL}`,
      );
    }
    const format = optionalString(form, "response_format");
    if (format !== undefined && format !== "json") {
      throw new RelayError(
        400,
        "invalid_request",
        "response_format must be json",
      );
    }
    const prompt = optionalString(form, "prompt");
    if (prompt !== undefined && prompt.length > MAX_PROMPT_CHARS) {
      throw new RelayError(
        400,
        "invalid_request",
        "prompt exceeds 1000 characters",
      );
    }
    const language = optionalString(form, "language");
    if (language !== undefined && !/^[a-z]{2}$/.test(language)) {
      throw new RelayError(
        400,
        "invalid_request",
        "language must be ISO-639-1",
      );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    log.bytes = bytes.length;
    const parsed = parseWav(bytes);
    if (!parsed.ok || !isSpeechWav(parsed.wav)) {
      throw new RelayError(
        415,
        "unsupported_audio_format",
        "file must be a 16 kHz mono 16-bit PCM WAV",
      );
    }
    const { pcm: raw, sampleRate } = parsed.wav;

    let pcm = raw;
    let originalMs = Math.round((raw.length / sampleRate) * 1000);
    let keptMs = originalMs;
    if (c.req.header("x-rtech-client-trimmed") !== "1") {
      const trimmed = trimSilence(raw, sampleRate);
      originalMs = trimmed.originalMs;
      keptMs = trimmed.keptMs;
      pcm = trimmed.pcm;
      if (!trimmed.hasSpeech) {
        log.original_ms = originalMs;
        log.kept_ms = 0;
        log.chunks = 0;
        c.header("x-rtech-audio-original-ms", String(originalMs));
        c.header("x-rtech-audio-kept-ms", "0");
        c.header("x-rtech-no-speech", "1");
        return c.json({ text: "" }, 200);
      }
    }
    log.original_ms = originalMs;
    log.kept_ms = keptMs;

    const chunks = splitPcm(pcm, sampleRate);
    log.chunks = chunks.length;

    const slot = await semaphore.acquire();
    if (!slot.ok) {
      throw new RelayError(
        503,
        "upstream_busy",
        "upstream is busy",
        undefined,
        5,
      );
    }
    releases.push(slot.release);

    const total = new AbortController();
    const cancelTotal = clock.setTimer(
      () => total.abort(new DOMException("request timed out", "TimeoutError")),
      REQUEST_TIMEOUT_MS,
    );
    releases.push(cancelTotal);

    const texts: string[] = [];
    for (const chunk of chunks) {
      const body = new FormData();
      body.set(
        "file",
        new Blob([makePcmWav(chunk, sampleRate) as Uint8Array<ArrayBuffer>], {
          type: "audio/wav",
        }),
        "audio.wav",
      );
      body.set("model", deps.config.VOICE_STT_MODEL);
      if (language !== undefined) body.set("language", language);
      if (prompt !== undefined) body.set("prompt", prompt);
      body.set("response_format", "json");
      texts.push(await callUpstream(body, total.signal, log));
    }

    const text = collapseRepeatedSentences(mergeChunkTexts(texts));
    c.header("x-rtech-audio-original-ms", String(originalMs));
    c.header("x-rtech-audio-kept-ms", String(keptMs));
    return c.json({ text }, 200);
  }

  async function callUpstream(
    body: FormData,
    total: AbortSignal,
    log: LogFields,
  ): Promise<string> {
    const headers: Record<string, string> = {};
    if (deps.config.VOICE_UPSTREAM_API_KEY) {
      headers.Authorization = `Bearer ${deps.config.VOICE_UPSTREAM_API_KEY}`;
    }
    const signal = AbortSignal.any([
      total,
      AbortSignal.timeout(CHUNK_TIMEOUT_MS),
    ]);
    let res: Response;
    try {
      res = await doFetch(upstreamUrl, {
        method: "POST",
        headers,
        body,
        signal,
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError" || name === "AbortError" || signal.aborted) {
        throw new RelayError(504, "upstream_timeout", "upstream timed out");
      }
      throw new RelayError(503, "upstream_unavailable", "upstream unreachable");
    }
    log.upstream_status = res.status;
    if (!res.ok) {
      await res.body?.cancel();
      throw new RelayError(
        502,
        "upstream_error",
        "upstream returned an error",
        {
          upstream_status: res.status,
        },
      );
    }
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      payload = undefined;
    }
    const text = (payload as { text?: unknown } | undefined)?.text;
    if (typeof text !== "string") {
      throw new RelayError(
        502,
        "upstream_error",
        "upstream reply had no text",
        {
          upstream_status: res.status,
        },
      );
    }
    return text;
  }

  return app;
}

function optionalString(form: FormData, name: string): string | undefined {
  const v = form.get(name);
  if (v === null) return undefined;
  if (typeof v !== "string") {
    throw new RelayError(
      400,
      "invalid_request",
      `${name} must be a text field`,
    );
  }
  return v;
}
