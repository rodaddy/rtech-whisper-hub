/**
 * The OpenAI-shaped face of the server voice:
 * POST /voice/v1/audio/speech answers audio bytes for a stock OpenAI SDK,
 * GET /voice/v1/audio/voices lists the voice, and
 * GET /voice/.well-known/speech describes the routes. Synthesis goes through
 * the same limiters and upstream call as the 10.2 route.
 *
 * The input, the audio and the voice name are never logged.
 */
import { Hono } from "hono";
import { z } from "zod";
import { systemClock } from "./limits.ts";
import { readBody } from "./bodyTimeout.ts";
import {
  MAX_TEXT_CHARS,
  SAMPLE_RATE,
  SYNTHESIS_BODY_LIMIT,
  type Status,
  type SynthesizeDeps,
  callVoiceUpstream,
  envelope,
} from "./synthesizeRoute.ts";
import { parseWav } from "./wav.ts";

export const SPEECH_PATH = "/voice/v1/audio/speech";
export const VOICES_PATH = "/voice/v1/audio/voices";
export const DISCOVERY_PATH = "/voice/.well-known/speech";
const VOICE_ID = "skippy";
/** The limiter key: one budget with the 10.2 route. */
const LIMIT_ROUTE = "synthesis";

const RequestBody = z.object({
  model: z.string().optional(),
  voice: z.string(),
  input: z.string(),
  response_format: z.enum(["wav", "pcm"]).default("wav"),
  speed: z.number().optional(),
});

/** The hub's envelope plus the two keys stock OpenAI SDKs read. */
function speechError(
  status: Status | 408,
  code: string,
  message: string,
  data?: Record<string, unknown>,
) {
  const body = envelope(code, message, data);
  const type = status >= 500 ? "server_error" : "invalid_request_error";
  return { ...body, error: { ...body.error, type, code } };
}

export function speechRoutes(deps: SynthesizeDeps) {
  const { logger, limiters, profile } = deps;
  const clock = deps.clock ?? systemClock;
  const app = new Hono();

  app.get(DISCOVERY_PATH, (c) =>
    c.json({
      speech: "v1/audio/speech",
      voices: "v1/audio/voices",
      transcriptions: "v1/audio/transcriptions",
      response_formats: ["wav", "pcm"],
      sample_rate: SAMPLE_RATE,
    }),
  );

  app.get(VOICES_PATH, (c) =>
    c.json({ voices: profile ? [{ id: VOICE_ID, name: "Skippy" }] : [] }),
  );

  app.post(
    SPEECH_PATH,
    readBody({
      maxSize: SYNTHESIS_BODY_LIMIT,
      clock,
      onTooLarge: (c) =>
        c.json(
          speechError(413, "payload_too_large", "speech body exceeds 4 MB"),
          413,
        ),
      onTimeout: (c) =>
        c.json(
          speechError(
            408,
            "request_timeout",
            "request body not received within 30 s",
          ),
          408,
        ),
    }),
    async (c) => {
      const started = clock.now();
      const deviceId = deps.getDeviceId(c);
      const log: Record<string, unknown> = {
        device_id: deviceId,
        route: "speech",
      };
      const done = (status: number, code?: string) =>
        logger.info(
          {
            ...log,
            status,
            ...(code ? { code } : {}),
            duration_ms: clock.now() - started,
          },
          "voice synthesis",
        );
      const reply = (
        status: Status,
        code: string,
        message: string,
        data?: Record<string, unknown>,
        headers?: Record<string, string>,
      ) => {
        done(status, code);
        return c.json(
          speechError(status, code, message, data),
          status,
          headers,
        );
      };

      const taken = limiters.rate.take(deviceId, LIMIT_ROUTE);
      if (!taken.ok) {
        return reply(
          429,
          "rate_limited",
          "synthesis rate limit exceeded",
          undefined,
          { "Retry-After": String(taken.retryAfterSeconds) },
        );
      }
      const releaseInFlight = limiters.inFlight.acquire(deviceId, LIMIT_ROUTE);
      if (!releaseInFlight) {
        return reply(
          429,
          "rate_limited",
          "too many synthesis requests in flight",
          undefined,
          { "Retry-After": "1" },
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
          return reply(
            400,
            "invalid_request",
            'voice and input must be strings; response_format, when sent, "wav" or "pcm"; speed, when sent, a number',
          );
        }
        const { response_format: format, speed } = parsed.data;
        const text = parsed.data.input.trim();
        const chars = [...text].length;
        log.text_chars = chars;
        if (chars === 0) return reply(400, "invalid_request", "input is empty");
        if (chars > MAX_TEXT_CHARS) {
          return reply(
            400,
            "text_too_long",
            `input exceeds ${MAX_TEXT_CHARS} characters`,
          );
        }
        if (parsed.data.voice.toLowerCase() !== VOICE_ID) {
          return reply(400, "invalid_request", "unknown voice");
        }
        if (!profile) {
          return reply(
            503,
            "upstream_unavailable",
            "voice profile not configured",
          );
        }

        const out = await callVoiceUpstream(deps, {
          text,
          voice: {
            audio_base64: profile.audioBase64,
            prompt_text: profile.promptText,
          },
          render: {},
          log,
        });
        if (!out.ok) {
          return reply(
            out.status,
            out.code,
            out.message,
            out.data,
            out.retryAfter ? { "Retry-After": out.retryAfter } : undefined,
          );
        }
        let audio: Uint8Array = out.wav;
        if (format === "pcm") {
          // parseWav also proves the 16-bit depth the pcm format promises.
          const wav = parseWav(out.wav);
          if (!wav.ok) {
            return reply(
              502,
              "upstream_error",
              "voice upstream returned malformed 24 kHz WAV",
            );
          }
          const { pcm } = wav.wav;
          audio = new Uint8Array(pcm.length * 2);
          const view = new DataView(audio.buffer);
          pcm.forEach((sample, i) => view.setInt16(i * 2, sample, true));
          log.bytes_out = audio.length;
        }
        done(200);
        return c.body(audio as Uint8Array<ArrayBuffer>, 200, {
          "content-type": format === "pcm" ? "audio/pcm" : "audio/wav",
          ...(speed !== undefined && speed !== 1
            ? { "x-speech-warning": "speed is ignored" }
            : {}),
        });
      } finally {
        releaseInFlight();
      }
    },
  );

  return app;
}
