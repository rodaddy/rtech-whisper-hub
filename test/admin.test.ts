import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { after, before, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import pino from "pino";
import { createApp } from "../src/app.ts";
import type { Db } from "../src/db/client.ts";
import { mintDevice } from "../src/keys.ts";
import { testDb } from "./helpers.ts";

const ADMIN = "admin-token-for-tests-0123456789abcdef";
const UNAUTHORIZED = {
  error: { message: "unauthorized" },
  code: "unauthorized",
};

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
    adminToken: ADMIN,
    ownerId: "rico",
  });
});
after(async () => client.close());

function req(path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return app.request(path, {
    method: body === undefined && !path.endsWith("/revoke") ? "GET" : "POST",
    headers,
    ...(body === undefined
      ? {}
      : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

test("admin routes return 401 with no token", async () => {
  for (const res of [
    await req("/admin/devices"),
    await req("/admin/devices", undefined, { name: "x" }),
  ]) {
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), UNAUTHORIZED);
  }
});

test("admin routes return 401 for a wrong token of equal length", async () => {
  const wrong = "X".repeat(ADMIN.length);
  assert.equal(wrong.length, ADMIN.length);
  const res = await req("/admin/devices", wrong);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), UNAUTHORIZED);
});

test("admin routes return 401 for a wrong token of a different length", async () => {
  const res = await req("/admin/devices", "short");
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), UNAUTHORIZED);
});

test("a device key never passes admin auth", async () => {
  const d = await mintDevice(db, "not-an-admin", "rico");
  const res = await req("/admin/devices", d.key);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), UNAUTHORIZED);
});

test("the admin token never passes /api device auth", async () => {
  const res = await req("/api/whoami", ADMIN);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), UNAUTHORIZED);
});

test("mint, list, use, revoke through the admin routes", async () => {
  const mint = await req("/admin/devices", ADMIN, { name: "Rico iPhone" });
  assert.equal(mint.status, 201);
  const minted = (await mint.json()) as {
    device: { id: string; name: string; prefix: string };
    key: string;
  };
  assert.equal(minted.device.name, "Rico iPhone");
  assert.match(minted.key, /^rtw_[A-Za-z0-9_-]{43}$/);
  assert.equal(minted.device.prefix, minted.key.slice(0, 12));

  const list = await req("/admin/devices", ADMIN);
  assert.equal(list.status, 200);
  const listText = await list.text();
  assert.ok(!listText.includes(minted.key), "list leaks the key");
  const { devices } = JSON.parse(listText) as {
    devices: Record<string, unknown>[];
  };
  const row = devices.find((d) => d.id === minted.device.id);
  assert.ok(row, "minted device missing from list");
  assert.deepEqual(Object.keys(row).sort(), [
    "created_at",
    "id",
    "last_used_at",
    "name",
    "owner_id",
    "prefix",
    "revoked_at",
  ]);
  assert.equal(row.revoked_at, null);

  const who = await req("/api/whoami", minted.key);
  assert.equal(who.status, 200);
  assert.deepEqual(await who.json(), {
    device: { id: minted.device.id, name: "Rico iPhone" },
  });

  const revoke = await req(
    `/admin/devices/${minted.device.prefix}/revoke`,
    ADMIN,
  );
  assert.equal(revoke.status, 200);
  assert.deepEqual(await revoke.json(), { revoked: true });

  const after = await req("/api/whoami", minted.key);
  assert.equal(after.status, 401);
});

test("revoke of an unknown prefix is 404", async () => {
  const res = await req("/admin/devices/rtw_nomatch00/revoke", ADMIN);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), {
    error: { message: "not found" },
    code: "not_found",
  });
});

test("a bad mint body is 400 invalid_request", async () => {
  for (const body of [
    {},
    { name: "" },
    { name: "x".repeat(101) },
    { name: 7 },
    "not json",
  ]) {
    const res = await req("/admin/devices", ADMIN, body);
    assert.equal(res.status, 400);
    const json = (await res.json()) as {
      error: { message: string };
      code: string;
    };
    assert.equal(json.code, "invalid_request");
    assert.equal(typeof json.error.message, "string");
  }
});

test("the mint log line carries admin:true and neither the token nor the key", async () => {
  lines.length = 0;
  const res = await req("/admin/devices", ADMIN, { name: "log-check" });
  assert.equal(res.status, 201);
  const { key } = (await res.json()) as { key: string };

  assert.equal(lines.length, 1);
  const line = lines[0];
  const entry = JSON.parse(line);
  assert.equal(entry.admin, true);
  assert.equal(entry.method, "POST");
  assert.equal(entry.path, "/admin/devices");
  assert.equal(entry.status, 201);
  assert.equal(typeof entry.duration_ms, "number");
  assert.ok(!line.includes(ADMIN), "log line contains the admin token");
  assert.ok(!line.includes(key), "log line contains the minted key");
  assert.ok(!line.includes("log-check"), "log line contains the body");
});

test("mint with an owner stores it, and mint without one uses the hub default", async () => {
  const named = await req("/admin/devices", ADMIN, {
    name: "Ana phone",
    owner: "ana",
  });
  assert.equal(named.status, 201);
  const a = (await named.json()) as {
    device: { id: string; owner_id: string };
  };
  assert.equal(a.device.owner_id, "ana");

  const plain = await req("/admin/devices", ADMIN, { name: "Default phone" });
  assert.equal(plain.status, 201);
  const r = (await plain.json()) as {
    device: { id: string; owner_id: string };
  };
  assert.equal(r.device.owner_id, "rico");

  const list = await req("/admin/devices", ADMIN);
  const { devices } = (await list.json()) as {
    devices: { id: string; owner_id: string }[];
  };
  assert.equal(devices.find((d) => d.id === a.device.id)?.owner_id, "ana");
  assert.equal(devices.find((d) => d.id === r.device.id)?.owner_id, "rico");
});

test("an owner of 101 characters is 400 invalid_request", async () => {
  const res = await req("/admin/devices", ADMIN, {
    name: "x",
    owner: "o".repeat(101),
  });
  assert.equal(res.status, 400);
  const json = (await res.json()) as { code: string };
  assert.equal(json.code, "invalid_request");
});
