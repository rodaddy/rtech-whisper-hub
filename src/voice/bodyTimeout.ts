// The voice routes' body read (docs/protocol.md 10.3): the body is buffered in
// memory under a size cap (413) and a read deadline (30 s, 408). This replaces
// hono's bodyLimit, which buffers a chunked body itself with no deadline, so
// the deadline has to live where the bytes are actually read. The clock is
// injectable so tests advance time instead of waiting.

import type { Context, MiddlewareHandler } from "hono";
import type { Clock } from "./limits.ts";

export const BODY_READ_TIMEOUT_MS = 30_000;

export interface ReadBodyOptions {
  maxSize: number;
  clock: Clock;
  timeoutMs?: number;
  onTooLarge(c: Context): Response;
  onTimeout(c: Context): Response;
}

export function readBody(opts: ReadBodyOptions): MiddlewareHandler {
  const timeoutMs = opts.timeoutMs ?? BODY_READ_TIMEOUT_MS;
  return async (c, next) => {
    const raw = c.req.raw;
    if (!raw.body) return next();
    const declared = raw.headers.get("content-length");
    if (
      declared !== null &&
      !raw.headers.has("transfer-encoding") &&
      Number.parseInt(declared, 10) > opts.maxSize
    ) {
      return opts.onTooLarge(c);
    }

    const reader = raw.body.getReader();
    let expire!: () => void;
    const deadline = new Promise<"timeout">((r) => {
      expire = () => r("timeout");
    });
    const cancelTimer = opts.clock.setTimer(expire, timeoutMs);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const step = await Promise.race([reader.read(), deadline]);
        if (step === "timeout") {
          reader.cancel().catch(() => {});
          return opts.onTimeout(c);
        }
        if (step.done) break;
        size += step.value.length;
        if (size > opts.maxSize) {
          reader.cancel().catch(() => {});
          return opts.onTooLarge(c);
        }
        chunks.push(step.value);
      }
    } finally {
      cancelTimer();
    }
    c.req.raw = new Request(raw, {
      body: new Blob(chunks as Uint8Array<ArrayBuffer>[]),
      duplex: "half",
    } as RequestInit);
    return next();
  };
}
