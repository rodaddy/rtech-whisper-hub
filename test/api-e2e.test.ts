import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import pino from "pino";
import { createApp } from "../src/app.ts";
import type { Db } from "../src/db/client.ts";
import type { Note } from "../src/sync/notes.ts";
import { testDb } from "./helpers.ts";

// End to end through createApp: the real device auth in front of the mounted
// sync routes, on PGlite.

const ADMIN = "admin-token-for-e2e-0123456789abcdef";
const UNAUTHORIZED = {
  error: { message: "unauthorized" },
  code: "unauthorized",
};

let db: Db;
let client: PGlite;
let app: ReturnType<typeof createApp>;
let key: string;

type Json = any;

async function call(
  method: string,
  path: string,
  token: string | undefined,
  body?: unknown,
) {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Json };
}

before(async () => {
  ({ db, client } = await testDb());
  app = createApp({
    db,
    logger: pino({ level: "silent" }),
    adminToken: ADMIN,
    ownerId: "rico",
  });
  const mint = await call("POST", "/admin/devices", ADMIN, { name: "e2e" });
  assert.equal(mint.status, 201);
  key = mint.json.key;
});
after(async () => client.close());

test("no key is 401 on /api/notes/list", async () => {
  const r = await call("GET", "/api/notes/list", undefined);
  assert.equal(r.status, 401);
  assert.deepEqual(r.json, UNAUTHORIZED);
});

test("the admin token is rejected on /api/notes/list", async () => {
  const r = await call("GET", "/api/notes/list", ADMIN);
  assert.equal(r.status, 401);
  assert.deepEqual(r.json, UNAUTHORIZED);
});

test("/api/me/spaces is 404 so the desktop stays personal-only", async () => {
  const r = await call("GET", "/api/me/spaces", key);
  assert.equal(r.status, 404);
  assert.deepEqual(r.json, {
    error: { message: "not found" },
    code: "not_found",
  });
});

test("folder, note, update, delta, delete, tombstone with a device key", async () => {
  const start = "1970-01-01T00:00:00.000Z";

  const folder = await call("POST", "/api/folders/create", key, {
    client_folder_id: "e2e-folder",
    name: "Work",
  });
  assert.equal(folder.status, 200);

  const created = await call("POST", "/api/notes/create", key, {
    client_note_id: "e2e-note",
    content: "v1",
    folder_id: folder.json.id,
  });
  assert.equal(created.status, 200);
  const n = created.json as Note;
  assert.equal(n.folder_id, folder.json.id);
  assert.equal(n.user_id, "rico");

  const updated = await call("PATCH", "/api/notes/update", key, {
    id: n.id,
    content: "v2",
    base_updated_at: n.updated_at,
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.content, "v2");

  const delta = await call("GET", `/api/notes/list?since=${start}`, key);
  assert.equal(delta.status, 200);
  const live = (delta.json.notes as Note[]).find((x) => x.id === n.id);
  assert.equal(live?.content, "v2");
  assert.equal(live?.deleted_at, null);

  const del = await call("DELETE", "/api/notes/delete", key, { id: n.id });
  assert.equal(del.status, 200);

  const q = new URLSearchParams({
    since: updated.json.updated_at,
    since_id: n.id,
  });
  const after = await call("GET", `/api/notes/list?${q}`, key);
  assert.equal(after.status, 200);
  const tomb = (after.json.notes as Note[]).find((x) => x.id === n.id);
  assert.ok(tomb?.deleted_at, "tombstone travels in the delta");
});
