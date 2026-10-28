import { timingSafeEqual } from "node:crypto";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import { ping, type Db } from "./db/client.ts";
import type { Config } from "./config.ts";
import { fail, STATUS } from "./http/errors.ts";
import { authenticate, listDevices, mintDevice, revokeDevice } from "./keys.ts";
import { LLM_LIMITS, type LlmUpstream, llmRoutes } from "./llm/relay.ts";
import { handleMcp } from "./mcp.ts";
import { dictionaryRoutes } from "./routes/dictionary.ts";
import { foldersRoutes } from "./routes/folders.ts";
import { notesRoutes } from "./routes/notes.ts";
import { snippetsRoutes } from "./routes/snippets.ts";
import { transcriptionsRoutes } from "./routes/transcriptions.ts";
import { StampBudgetExceeded } from "./sync/common.ts";
import {
  type Clock,
  GLOBAL_CONCURRENCY,
  GLOBAL_QUEUE_WAIT_MS,
  InFlight,
  ROUTE_LIMITS,
  Semaphore,
  systemClock,
  TokenBucket,
} from "./voice/limits.ts";
import type { VoiceProfile } from "./voice/profile.ts";
import { speechRoutes } from "./voice/speechRoute.ts";
import { synthesizeRoutes } from "./voice/synthesizeRoute.ts";
import { transcribeRoutes } from "./voice/transcribeRoute.ts";

export type VoiceConfig = Pick<
  Config,
  "VOICE_UPSTREAM_URL" | "VOICE_UPSTREAM_API_KEY" | "VOICE_STT_MODEL"
>;

/** The config defaults, for callers (tests, admin tooling) that pass no voice config. */
const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  VOICE_UPSTREAM_URL: "http://localhost:8080",
  VOICE_STT_MODEL: "whisper-large-v3-turbo",
};

export interface Device {
  id: string;
  name: string;
  ownerId: string;
}

type Env = { Variables: { device: Device; admin: boolean } };

const UNAUTHORIZED = {
  error: { message: "unauthorized" },
  code: "unauthorized",
} as const;
const NOT_FOUND = {
  error: { message: "not found" },
  code: "not_found",
} as const;
const BEARER = /^Bearer (\S+)$/;
const MintBody = z.object({
  name: z.string().min(1).max(100),
  owner: z.string().min(1).max(100).optional(),
});

function invalidRequest(message: string) {
  return { error: { message }, code: "invalid_request" } as const;
}

/** Constant-time comparison; a length mismatch is a plain false, never an exception. */
function tokenMatches(given: string, expected: Buffer): boolean {
  const buf = Buffer.from(given, "utf8");
  return buf.length === expected.length && timingSafeEqual(buf, expected);
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

export function createApp({
  db,
  logger,
  adminToken,
  ownerId,
  voiceConfig = DEFAULT_VOICE_CONFIG,
  fetch = globalThis.fetch,
  clock = systemClock,
  voiceProfile = null,
  globalConcurrency = GLOBAL_CONCURRENCY,
  llmUpstream = { url: undefined, apiKey: undefined, allowlist: [] },
}: {
  db: Db;
  logger: Logger;
  adminToken: string;
  /** Owner a new key belongs to when the admin names none (config HUB_OWNER_ID). */
  ownerId: string;
  voiceConfig?: VoiceConfig;
  fetch?: typeof globalThis.fetch;
  clock?: Clock;
  /** The server voice profile, loaded once at startup; null means synthesis without a client voice is 503. */
  voiceProfile?: VoiceProfile | null;
  /** Upstream slots on the shared GPU; tests lower it. */
  globalConcurrency?: number;
  /** LLM relay upstream (resolveLlmUpstream); the default is unconfigured, so the relay answers 503. */
  llmUpstream?: LlmUpstream;
}) {
  const app = new Hono<Env>();
  const expectedAdmin = Buffer.from(adminToken, "utf8");

  // One semaphore for both voice routes: they share the GPU upstream.
  const semaphore = new Semaphore({
    max: globalConcurrency,
    maxWaitMs: GLOBAL_QUEUE_WAIT_MS,
    clock,
  });
  const bucketFor = (route: keyof typeof ROUTE_LIMITS) =>
    new TokenBucket({
      capacity: ROUTE_LIMITS[route].burst,
      perMinute: ROUTE_LIMITS[route].perMinute,
      clock,
    });

  app.use("*", async (c, next) => {
    const started = performance.now();
    await next();
    const device = c.get("device");
    logger.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        duration_ms: Math.round((performance.now() - started) * 1000) / 1000,
        ...(device ? { device_id: device.id } : {}),
        ...(c.get("admin") ? { admin: true } : {}),
      },
      "request",
    );
  });

  app.get("/healthz", async (c) => {
    try {
      await ping(db);
      return c.json({ ok: true }, 200);
    } catch (err) {
      logger.error(
        { err_name: err instanceof Error ? err.name : "unknown" },
        "health check ping failed",
      );
      return c.json({ ok: false }, 503);
    }
  });

  // One device-key check for the sync API and the remote MCP.
  const deviceAuth: MiddlewareHandler<Env> = async (c, next) => {
    const match = BEARER.exec(c.req.header("authorization") ?? "");
    const device = match ? await authenticate(db, match[1]) : null;
    if (!device) return c.json(UNAUTHORIZED, 401);
    c.set("device", device);
    await next();
  };
  app.use("/api/*", deviceAuth);
  app.use("/mcp", deviceAuth);

  // Remote MCP, stateless Streamable HTTP (POST only; no sessions to GET or DELETE).
  app.post("/mcp", (c) =>
    handleMcp(db, (c.get("device") as Device).ownerId, c.req.raw),
  );

  app.get("/api/whoami", (c) => {
    const device = c.get("device");
    return c.json({ device: { id: device.id, name: device.name } }, 200);
  });

  // Contract section 2: no spaces on this hub, so the desktop stays in
  // personal-only mode. The 404 is deliberate, not a missing route.
  app.get("/api/me/spaces", (c) => c.json(NOT_FOUND, 404));

  app.route("/api", foldersRoutes(db));
  app.route("/api", notesRoutes(db));
  app.route("/api", dictionaryRoutes(db));
  app.route("/api", snippetsRoutes(db));
  app.route("/api", transcriptionsRoutes(db));
  // Voice relay (docs/protocol.md 10), behind the /api/* device auth above.
  const getDeviceId = (c: Context) => (c.get("device") as Device).id;
  app.route(
    "/api",
    transcribeRoutes({
      config: voiceConfig,
      logger,
      fetch,
      clock,
      limiters: {
        bucket: bucketFor("transcription"),
        inFlight: new InFlight(ROUTE_LIMITS.transcription.inFlight),
        semaphore,
      },
      getDeviceId,
    }),
  );
  // One synthesis budget per device key, shared by the 10.2 route and the
  // OpenAI-shaped speech route.
  const synthesisDeps = {
    config: voiceConfig,
    logger,
    fetch,
    clock,
    limiters: {
      rate: bucketFor("synthesis"),
      inFlight: new InFlight(ROUTE_LIMITS.synthesis.inFlight),
      upstream: semaphore,
    },
    profile: voiceProfile,
    getDeviceId,
  };
  app.route("/api", synthesizeRoutes(synthesisDeps));
  app.route("/api", speechRoutes(synthesisDeps));

  // LLM relay (docs/protocol.md 11), same device auth; its own limits, no shared GPU semaphore.
  app.route(
    "/api",
    llmRoutes({
      upstream: llmUpstream,
      logger,
      fetch,
      clock,
      limiters: {
        rate: new TokenBucket({
          capacity: LLM_LIMITS.burst,
          perMinute: LLM_LIMITS.perMinute,
          clock,
        }),
        inFlight: new InFlight(LLM_LIMITS.inFlight),
      },
      getDeviceId,
    }),
  );

  app.use("/admin/*", async (c, next) => {
    c.set("admin", true);
    const match = BEARER.exec(c.req.header("authorization") ?? "");
    if (!match || !tokenMatches(match[1], expectedAdmin)) {
      return c.json(UNAUTHORIZED, 401);
    }
    await next();
  });

  app.post("/admin/devices", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(invalidRequest("body must be JSON"), 400);
    }
    const parsed = MintBody.safeParse(body);
    if (!parsed.success) {
      return c.json(
        invalidRequest(
          "name must be a string of 1-100 characters; owner, when given, too",
        ),
        400,
      );
    }
    const d = await mintDevice(
      db,
      parsed.data.name,
      parsed.data.owner ?? ownerId,
    );
    return c.json(
      {
        device: {
          id: d.id,
          name: d.name,
          prefix: d.prefix,
          owner_id: d.ownerId,
        },
        key: d.key,
      },
      201,
    );
  });

  app.get("/admin/devices", async (c) => {
    const devices = (await listDevices(db)).map((d) => ({
      id: d.id,
      name: d.name,
      prefix: d.prefix,
      owner_id: d.ownerId,
      created_at: iso(d.createdAt),
      last_used_at: iso(d.lastUsedAt),
      revoked_at: iso(d.revokedAt),
    }));
    return c.json({ devices }, 200);
  });

  app.post("/admin/devices/:idOrPrefix/revoke", async (c) => {
    const revoked = await revokeDevice(db, c.req.param("idOrPrefix"));
    return revoked ? c.json({ revoked: true }, 200) : c.json(NOT_FOUND, 404);
  });

  app.notFound((c) => c.json(NOT_FOUND, 404));

  // A write that ran past the stamp budget rolled back; it is safe to retry
  // (docs/protocol.md section 8, Cursors). Anything else gets Hono's default
  // handler, restated here because setting onError replaces it.
  app.onError((err, c) => {
    if (err instanceof StampBudgetExceeded) {
      logger.warn(
        { path: c.req.path, err_message: err.message },
        "stamp budget exceeded",
      );
      return fail(
        c,
        STATUS.stamp_budget_exceeded,
        "stamp_budget_exceeded",
        "the write took too long and was rolled back; retry it",
      );
    }
    if ("getResponse" in err) {
      const res = err.getResponse();
      return c.newResponse(res.body, res);
    }
    console.error(err);
    return c.text("Internal Server Error", 500);
  });

  return app;
}
