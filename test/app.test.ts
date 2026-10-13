import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { after, before, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import pino from "pino";
import { createApp } from "../src/app.ts";
import type { Db } from "../src/db/client.ts";
import { mintDevice, revokeDevice } from "../src/keys.ts";
import { testDb } from "./helpers.ts";

let db: Db;
let client: PGlite;
let lines: string[];
let app: ReturnType<typeof createApp>;

before(async () => {
  ({ db, client } = await testDb());
  lines = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      lines.push(...String(chunk).split("\n").filter(Boolean));
      cb();
    },
  });
  app = createApp({
    db,
    logger: pino({ level: "info" }, sink),
    adminToken: "t".repeat(40),
    ownerId: "rico",
  });
});
after(async () => client.close());

const bearer = (key: string) => ({
  headers: { Authorization: `Bearer ${key}` },
});

test("/healthz is 200 without auth", async () => {
  const res = await app.request("/healthz");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("/api/whoami rejects missing and wrong keys with the unauthorized body", async () => {
  for (const init of [{}, bearer(`rtw_${"x".repeat(43)}`), bearer("garbage")]) {
    const res = await app.request("/api/whoami", init);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), {
      error: { message: "unauthorized" },
      code: "unauthorized",
    });
  }
});

test("/api/whoami returns the device for a minted key, then 401 after revoke", async () => {
  const d = await mintDevice(db, "iphone", "rico");
  lines.length = 0;
  const res = await app.request("/api/whoami?token=secret-q", bearer(d.key));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { device: { id: d.id, name: "iphone" } });

  assert.equal(lines.length, 1);
  const line = lines[0];
  const entry = JSON.parse(line);
  assert.equal(entry.device_id, d.id);
  assert.equal(entry.path, "/api/whoami");
  assert.equal(entry.status, 200);
  assert.equal(typeof entry.duration_ms, "number");
  assert.ok(!line.includes(d.key), "log line contains the key");
  assert.ok(
    !line.toLowerCase().includes("authorization"),
    "log line mentions authorization",
  );
  assert.ok(!line.includes("secret-q"), "log line contains the query string");

  await revokeDevice(db, d.id);
  const after = await app.request("/api/whoami", bearer(d.key));
  assert.equal(after.status, 401);
});

test("unknown routes return the not_found JSON body", async () => {
  const res = await app.request("/nope");
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), {
    error: { message: "not found" },
    code: "not_found",
  });
});

test("/healthz is 503 when the database ping fails", async () => {
  const broken = await testDb();
  await broken.client.close();
  const res = await createApp({
    db: broken.db,
    logger: pino({ level: "silent" }),
    adminToken: "t".repeat(40),
    ownerId: "rico",
  }).request("/healthz");
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ok: false });
});
