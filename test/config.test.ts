import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";

const URL = "postgres://hub:pw@db:5432/hub";
const TOKEN = "a".repeat(32);
const BASE = { DATABASE_URL: URL, HUB_ADMIN_TOKEN: TOKEN };

test("defaults HUB_PORT and LOG_LEVEL", () => {
  assert.deepEqual(loadConfig(BASE), {
    HUB_PORT: 8096,
    DATABASE_URL: URL,
    LOG_LEVEL: "info",
    HUB_ADMIN_TOKEN: TOKEN,
    HUB_OWNER_ID: "rico",
    VOICE_UPSTREAM_URL: "http://localhost:8080",
    VOICE_UPSTREAM_API_KEY: undefined,
    VOICE_STT_MODEL: "whisper-large-v3-turbo",
    VOICE_PROFILE_DIR: undefined,
    LLM_UPSTREAM_URL: undefined,
    LLM_UPSTREAM_API_KEY: undefined,
    LLM_MODEL_ALLOWLIST: undefined,
  });
});

test("voice relay settings pass through when set", () => {
  const c = loadConfig({
    ...BASE,
    VOICE_UPSTREAM_URL: "http://gpu:8080",
    VOICE_UPSTREAM_API_KEY: "k",
    VOICE_STT_MODEL: "whisper-small",
    VOICE_PROFILE_DIR: "/profiles/skippy",
  });
  assert.equal(c.VOICE_UPSTREAM_URL, "http://gpu:8080");
  assert.equal(c.VOICE_UPSTREAM_API_KEY, "k");
  assert.equal(c.VOICE_STT_MODEL, "whisper-small");
  assert.equal(c.VOICE_PROFILE_DIR, "/profiles/skippy");
});

test("bad VOICE_UPSTREAM_URL is rejected without echoing the value", () => {
  for (const v of ["not a url", "ftp://secret-host/x"]) {
    assert.throws(
      () => loadConfig({ ...BASE, VOICE_UPSTREAM_URL: v }),
      (err: Error) =>
        err.message.includes("VOICE_UPSTREAM_URL") && !err.message.includes(v),
    );
  }
});

test("HUB_OWNER_ID overrides the default owner", () => {
  assert.equal(
    loadConfig({ ...BASE, HUB_OWNER_ID: "someone" }).HUB_OWNER_ID,
    "someone",
  );
});

test("missing DATABASE_URL names the variable", () => {
  assert.throws(() => loadConfig({ HUB_ADMIN_TOKEN: TOKEN }), /DATABASE_URL/);
});

test("non-postgres DATABASE_URL is rejected without echoing the value", () => {
  assert.throws(
    () =>
      loadConfig({
        DATABASE_URL: "mysql://user:hunter2@x/db",
        HUB_ADMIN_TOKEN: TOKEN,
      }),
    (err: Error) =>
      err.message.includes("DATABASE_URL") && !err.message.includes("hunter2"),
  );
});

test("invalid HUB_PORT names the variable", () => {
  for (const HUB_PORT of ["abc", "0", "70000", "80.5"]) {
    assert.throws(() => loadConfig({ ...BASE, HUB_PORT }), /HUB_PORT/);
  }
});

test("missing HUB_ADMIN_TOKEN names the variable", () => {
  assert.throws(() => loadConfig({ DATABASE_URL: URL }), /HUB_ADMIN_TOKEN/);
});

test("short HUB_ADMIN_TOKEN is rejected without echoing the value", () => {
  const short = "hunter2-short-token-31-chars-xx";
  assert.equal(short.length, 31);
  assert.throws(
    () => loadConfig({ DATABASE_URL: URL, HUB_ADMIN_TOKEN: short }),
    (err: Error) =>
      err.message.includes("HUB_ADMIN_TOKEN") && !err.message.includes(short),
  );
});
