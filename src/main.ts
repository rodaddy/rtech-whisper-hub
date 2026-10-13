import { serve } from "@hono/node-server";
import pino from "pino";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { resolveLlmUpstream } from "./llm/relay.ts";
import { connect, runMigrations } from "./db/client.ts";
import { loadVoiceProfile } from "./voice/profile.ts";

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL });
const { db, close } = connect(config.DATABASE_URL);
await runMigrations(db);

// The hub starts without a profile; synthesis without a client voice is then 503.
// Log the outcome and reason code only, never the profile contents or path.
const loaded = await loadVoiceProfile(config.VOICE_PROFILE_DIR).catch(
  () => ({ ok: false, code: "read_error" }) as const,
);
if (loaded.ok) logger.info({ voice_profile: "configured" }, "voice profile");
else {
  logger.warn(
    { voice_profile: "not_configured", reason: loaded.code },
    "voice profile",
  );
}

const server = serve(
  {
    fetch: createApp({
      db,
      logger,
      adminToken: config.HUB_ADMIN_TOKEN,
      ownerId: config.HUB_OWNER_ID,
      voiceConfig: config,
      voiceProfile: loaded.ok ? loaded.profile : null,
      llmUpstream: resolveLlmUpstream(config),
    }).fetch,
    port: config.HUB_PORT,
  },
  (info) => {
    logger.info({ port: info.port }, "rtech-whisper-hub listening");
  },
);

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "shutting down");
  server.close(() => {
    close().then(
      () => process.exit(0),
      (err: unknown) => {
        logger.error({ err }, "database close failed");
        process.exit(1);
      },
    );
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
