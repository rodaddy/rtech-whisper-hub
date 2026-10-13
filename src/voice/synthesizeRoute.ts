/**
 * POST /voice/upstream/omnivoice/synthesize -- Skippy's voice relay
 * (docs/protocol.md sections 10.2, 10.3, 10.5, 10.6). Request and reply keep
 * the desktop's OmniVoice shape; the reply check is ported from the desktop
 * sibling's OmniVoiceTTS.synthesize_wav (server/agent/src/voice_agent/tts.py).
 *
 * Text, prompt_text, audio, and the render settings live only in memory and
 * are never logged.
 */
import { Hono, type Context } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import type { Config } from "../config.ts";
import {
  type Clock,
  type InFlight,
  type Semaphore,
  type TokenBucket,
  systemClock,
} from "./limits.ts";
import { readBody } from "./bodyTimeout.ts";
import type { VoiceProfile } from "./profile.ts";

export const SYNTHESIS_PATH = "/voice/upstream/omnivoice/synthesize";
const UPSTREAM_PATH = "/upstream/omnivoice/synthesize";
const ROUTE = "synthesis";
export const SYNTHESIS_BODY_LIMIT = 4 * 1024 * 1024;
export const SYNTHESIS_TIMEOUT_MS = 90_000;
export const MAX_TEXT_CHARS = 2000;
export const SAMPLE_RATE = 24_000;

/** The limiter pieces this route uses; see limits.ts for the classes. */
export interface SynthesisLimiters {
  /** Synthesis token bucket (30/min, burst 5). */
  rate: Pick<TokenBucket, "take">;
  /** Synthesis in-flight cap (2 per key). */
  inFlight: Pick<InFlight, "acquire">;
  /** Global upstream semaphore shared with transcription. */
  upstream: Pick<Semaphore, "acquire">;
}

export interface SynthesizeDeps {
  config: Pick<Config, "VOICE_UPSTREAM_URL" | "VOICE_UPSTREAM_API_KEY">;
  logger: Pick<Logger, "info">;
  fetch: typeof globalThis.fetch;
  clock?: Clock;
  limiters: SynthesisLimiters;
  /** Skippy's profile, loaded once at startup; null when not configured. */
  profile: VoiceProfile | null;
  getDeviceId(c: Context): string;
}

const RequestBody = z.object({
  text: z.string(),
  audio_base64: z.string().min(1).optional(),
  prompt_text: z.string().min(1).optional(),
  // Render settings, optional, with the voice server's own limits so a bad
  // value is the hub's 400 and never the upstream's 422.
  seed: z.number().int().min(1).max(1000).optional(),
  num_steps: z.number().int().min(10).max(20).optional(),
  guidance_scale: z.number().gt(0).max(10).optional(),
  language: z.string().min(1).max(32).optional(),
});

const RENDER_FIELDS = [
  "seed",
  "num_steps",
  "guidance_scale",
  "language",
] as const;

const UpstreamReply = z.object({
  audio_base64: z.string().min(1),
  sample_rate: z.literal(SAMPLE_RATE),
});

const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type Status = 400 | 413 | 429 | 502 | 503 | 504;

export function envelope(
  code: string,
  message: string,
  data?: Record<string, unknown>,
) {
  return { error: { message }, code, ...(data ? { data } : {}) };
}

/**
 * True when `wav` is a RIFF/WAVE, linear PCM, mono, 24 kHz, with at least one
 * frame -- the same checks Python's `wave` module makes in the desktop port.
 */
export function isSynthesisWav(wav: Uint8Array): boolean {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const ascii = (at: number) =>
    String.fromCharCode(...wav.subarray(at, at + 4));
  if (wav.length < 12 || ascii(0) !== "RIFF" || ascii(8) !== "WAVE")
    return false;
  let fmt: { channels: number; rate: number; blockAlign: number } | undefined;
  for (let offset = 12; offset <= wav.length - 8;) {
    const id = ascii(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > wav.length) return false;
      if (view.getUint16(body, true) !== 1) return false;
      fmt = {
        channels: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true),
        blockAlign: view.getUint16(body + 12, true),
      };
    } else if (id === "data") {
      if (
        !fmt ||
        fmt.channels !== 1 ||
        fmt.rate !== SAMPLE_RATE ||
        fmt.blockAlign < 1
      ) {
        return false;
      }
      const bytes = Math.min(size, wav.length - body);
      return Math.floor(bytes / fmt.blockAlign) >= 1;
    }
    offset = body + size + (size % 2);
  }
  return false;
}

function isTimeout(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  );
}

export type VoiceUpstreamResult =
  | { ok: true; audioBase64: string; wav: Buffer }
  | {
      ok: false;
      status: Status;
      code: string;
      message: string;
      data?: Record<string, unknown>;
      retryAfter?: string;
    };

/**
 * One synthesis call to the voice server: the upstream-semaphore slot, the
 * request, and the reply's WAV check. Shared by the 10.2 route and the
 * OpenAI-shaped speech route. Writes upstream_ms, upstream_status and
 * bytes_out into `log`; never the text or the audio.
 */
export async function callVoiceUpstream(
  deps: Pick<SynthesizeDeps, "config" | "fetch" | "clock" | "limiters">,
  req: {
    text: string;
    voice: { audio_base64: string; prompt_text: string };
    render: Record<string, number | string>;
    log: Record<string, unknown>;
  },
): Promise<VoiceUpstreamResult> {
  const { config, limiters } = deps;
  const { text, voice, render, log } = req;
  const clock = deps.clock ?? systemClock;
  const upstreamUrl =
    config.VOICE_UPSTREAM_URL.replace(/\/+$/, "") + UPSTREAM_PATH;
  const fail = (
    status: Status,
    code: string,
    message: string,
    data?: Record<string, unknown>,
    retryAfter?: string,
  ): VoiceUpstreamResult => ({
    ok: false,
    status,
    code,
    message,
    data,
    retryAfter,
  });

  const slot = await limiters.upstream.acquire();
  if (!slot.ok) {
    return fail(503, "upstream_busy", "voice upstream is busy", undefined, "5");
  }
  const upstreamStarted = clock.now();
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (config.VOICE_UPSTREAM_API_KEY) {
      headers.authorization = `Bearer ${config.VOICE_UPSTREAM_API_KEY}`;
    }
    let res: Response;
    try {
      res = await deps.fetch(upstreamUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ text, ...voice, ...render }),
        signal: AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS),
      });
    } catch (err) {
      log.upstream_ms = clock.now() - upstreamStarted;
      return isTimeout(err)
        ? fail(504, "upstream_timeout", "voice upstream timed out")
        : fail(503, "upstream_unavailable", "voice upstream unreachable");
    }
    log.upstream_status = res.status;
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      log.upstream_ms = clock.now() - upstreamStarted;
      return fail(502, "upstream_error", "voice upstream failed", {
        upstream_status: res.status,
      });
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      log.upstream_ms = clock.now() - upstreamStarted;
      if (isTimeout(err))
        return fail(504, "upstream_timeout", "voice upstream timed out");
      return fail(502, "upstream_error", "voice upstream reply was not JSON", {
        upstream_status: res.status,
      });
    }
    log.upstream_ms = clock.now() - upstreamStarted;
    const out = UpstreamReply.safeParse(body);
    const wav =
      out.success && BASE64.test(out.data.audio_base64)
        ? Buffer.from(out.data.audio_base64, "base64")
        : null;
    if (!out.success || !wav || !isSynthesisWav(wav)) {
      return fail(
        502,
        "upstream_error",
        "voice upstream returned malformed 24 kHz WAV",
        { upstream_status: res.status },
      );
    }
    log.bytes_out = wav.length;
    return { ok: true, audioBase64: out.data.audio_base64, wav };
  } finally {
    slot.release();
  }
}

export function synthesizeRoutes(deps: SynthesizeDeps) {
  const { logger, limiters, profile } = deps;
  const clock = deps.clock ?? systemClock;
  const app = new Hono();

  app.post(
    SYNTHESIS_PATH,
    readBody({
      maxSize: SYNTHESIS_BODY_LIMIT,
      clock,
      onTooLarge: (c) =>
        c.json(
          envelope("payload_too_large", "synthesis body exceeds 4 MB"),
          413,
        ),
      onTimeout: (c) =>
        c.json(
          envelope("request_timeout", "request body not received within 30 s"),
          408,
        ),
    }),
    async (c) => {
      const started = clock.now();
      const deviceId = deps.getDeviceId(c);
      const log: Record<string, unknown> = {
        device_id: deviceId,
        route: ROUTE,
      };
      const reply = (
        status: Status,
        code: string,
        message: string,
        data?: Record<string, unknown>,
        headers?: Record<string, string>,
      ) => {
        logger.info(
          { ...log, status, code, duration_ms: clock.now() - started },
          "voice synthesis",
        );
        return c.json(envelope(code, message, data), status, headers);
      };

      const taken = limiters.rate.take(deviceId, ROUTE);
      if (!taken.ok) {
        return reply(
          429,
          "rate_limited",
          "synthesis rate limit exceeded",
          undefined,
          {
            "Retry-After": String(taken.retryAfterSeconds),
          },
        );
      }
      const releaseInFlight = limiters.inFlight.acquire(deviceId, ROUTE);
      if (!releaseInFlight) {
        return reply(
          429,
          "rate_limited",
          "too many synthesis requests in flight",
          undefined,
          {
            "Retry-After": "1",
          },
        );
      }
      try {
        let raw: unknown;
        try {
          raw = await c.req.json();
        } catch {
          return reply(400, "invalid_request", "body must be JSON");
        }
        const parsed = RequestBody.safeParse(raw);
        if (!parsed.success) {
          const renderOnly = parsed.error.issues.every((issue) =>
            (RENDER_FIELDS as readonly unknown[]).includes(issue.path[0]),
          );
          return reply(
            400,
            "invalid_request",
            renderOnly
              ? "seed must be an integer 1..1000, num_steps an integer 10..20, guidance_scale a number above 0 and at most 10, language a string of 1..32 characters"
              : "text must be a string; audio_base64 and prompt_text, when sent, non-empty strings",
          );
        }
        const text = parsed.data.text.trim();
        const chars = [...text].length;
        log.text_chars = chars;
        if (chars === 0) return reply(400, "invalid_request", "text is empty");
        if (chars > MAX_TEXT_CHARS) {
          return reply(
            400,
            "text_too_long",
            `text exceeds ${MAX_TEXT_CHARS} characters`,
          );
        }

        const { audio_base64, prompt_text } = parsed.data;
        let voice: { audio_base64: string; prompt_text: string };
        if (audio_base64 !== undefined && prompt_text !== undefined) {
          voice = { audio_base64, prompt_text };
          log.voice = "client";
        } else if (audio_base64 === undefined && prompt_text === undefined) {
          if (!profile) {
            return reply(
              503,
              "upstream_unavailable",
              "voice profile not configured",
            );
          }
          voice = {
            audio_base64: profile.audioBase64,
            prompt_text: profile.promptText,
          };
          log.voice = "skippy";
        } else {
          return reply(
            400,
            "invalid_request",
            "audio_base64 and prompt_text must be sent together or not at all",
          );
        }
        const render: Record<string, number | string> = {};
        for (const field of RENDER_FIELDS) {
          const value = parsed.data[field];
          if (value !== undefined) render[field] = value;
        }

        const out = await callVoiceUpstream(deps, { text, voice, render, log });
        if (!out.ok) {
          return reply(
            out.status,
            out.code,
            out.message,
            out.data,
            out.retryAfter ? { "Retry-After": out.retryAfter } : undefined,
          );
        }
        logger.info(
          { ...log, status: 200, duration_ms: clock.now() - started },
          "voice synthesis",
        );
        return c.json(
          { audio_base64: out.audioBase64, sample_rate: SAMPLE_RATE },
          200,
        );
      } finally {
        releaseInFlight();
      }
    },
  );

  return app;
}
