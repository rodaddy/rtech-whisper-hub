import { z } from "zod";

const ConfigSchema = z.object({
  HUB_PORT: z.coerce.number().int().min(1).max(65535).default(8096),
  DATABASE_URL: z
    .string()
    .refine(
      (v) => v.startsWith("postgres://") || v.startsWith("postgresql://"),
      {
        message: "must start with postgres:// or postgresql://",
      },
    ),
  LOG_LEVEL: z.string().min(1).default("info"),
  HUB_ADMIN_TOKEN: z.string().min(32),
  // Owner a new device key gets when the admin names none, and the owner existing
  // data was backfilled to (migration 0002 backfills 'rico').
  HUB_OWNER_ID: z.string().min(1).default("rico"),
  VOICE_UPSTREAM_URL: z
    .url({ protocol: /^https?$/ })
    .default("http://localhost:8080"),
  VOICE_UPSTREAM_API_KEY: z.string().min(1).optional(),
  VOICE_STT_MODEL: z.string().min(1).default("whisper-large-v3-turbo"),
  /** Directory holding the server voice profile: ref.wav and ref.txt. */
  VOICE_PROFILE_DIR: z.string().min(1).optional(),
  /** llama-swap root for the LLM relay; unset reuses VOICE_UPSTREAM_URL. */
  LLM_UPSTREAM_URL: z.url({ protocol: /^https?$/ }).optional(),
  LLM_UPSTREAM_API_KEY: z.string().min(1).optional(),
  /** Comma-separated model ids the LLM relay accepts; unset or empty allows all. */
  LLM_MODEL_ALLOWLIST: z.string().min(1).optional(),
});

const blank = (v: string | undefined) => (v === "" ? undefined : v);

export type Config = z.infer<typeof ConfigSchema>;

/** Parse hub configuration from the environment. Errors name the variable, never its value. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = ConfigSchema.safeParse({
    HUB_PORT: env.HUB_PORT === "" ? undefined : env.HUB_PORT,
    DATABASE_URL: env.DATABASE_URL,
    LOG_LEVEL: env.LOG_LEVEL === "" ? undefined : env.LOG_LEVEL,
    HUB_ADMIN_TOKEN: env.HUB_ADMIN_TOKEN,
    HUB_OWNER_ID: env.HUB_OWNER_ID === "" ? undefined : env.HUB_OWNER_ID,
    VOICE_UPSTREAM_URL: blank(env.VOICE_UPSTREAM_URL),
    VOICE_UPSTREAM_API_KEY: blank(env.VOICE_UPSTREAM_API_KEY),
    VOICE_STT_MODEL: blank(env.VOICE_STT_MODEL),
    VOICE_PROFILE_DIR: blank(env.VOICE_PROFILE_DIR),
    LLM_UPSTREAM_URL: blank(env.LLM_UPSTREAM_URL),
    LLM_UPSTREAM_API_KEY: blank(env.LLM_UPSTREAM_API_KEY),
    LLM_MODEL_ALLOWLIST: blank(env.LLM_MODEL_ALLOWLIST),
  });
  if (!result.success) {
    const names = [
      ...new Set(result.error.issues.map((i) => String(i.path[0]))),
    ];
    throw new Error(
      `invalid configuration: ${names.join(", ")} is missing or invalid`,
    );
  }
  return result.data;
}
