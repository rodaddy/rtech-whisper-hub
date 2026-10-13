import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import type { Db } from "../src/db/client.ts";
import { notesRoutes } from "../src/routes/notes.ts";
import type { Note } from "../src/sync/notes.ts";
import { asOwner, testDb } from "./helpers.ts";

let db: Db;
let client: PGlite;
let app: Hono;
before(async () => {
  ({ db, client } = await testDb());
  app = asOwner("rico", notesRoutes(db));
});
after(async () => client.close());

type Json = any;

async function call(
  method: string,
  path: string,
  body?: unknown,
  via: Hono = app,
) {
  const res = await via.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Json };
}

async function create(client_note_id: string, content = "v1"): Promise<Note> {
  const r = await call("POST", "/api/notes/create", {
    client_note_id,
    content,
  });
  assert.equal(r.status, 200);
  return r.json;
}

test("create, update with the right base, stale base is 409 with data.note", async () => {
  const n = await create("r-occ");
  assert.equal(n.content, "v1");
  assert.equal(n.user_id, "rico");

  const v2 = await call("PATCH", "/api/notes/update", {
    id: n.id,
    content: "v2",
    base_updated_at: n.updated_at,
  });
  assert.equal(v2.status, 200);
  assert.equal(v2.json.content, "v2");

  const stale = await call("PATCH", "/api/notes/update", {
    id: n.id,
    content: "v3",
    base_updated_at: n.updated_at,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, "note_version_conflict");
  assert.equal(typeof stale.json.error.message, "string");
  assert.equal(stale.json.data.note.id, n.id);
  assert.equal(stale.json.data.note.content, "v2");
  assert.equal(stale.json.data.note.updated_at, v2.json.updated_at);
});

test("update without a base is last writer wins", async () => {
  const n = await create("r-lww");
  await call("PATCH", "/api/notes/update", { id: n.id, content: "a" });
  const r = await call("PATCH", "/api/notes/update", {
    id: n.id,
    content: "b",
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.content, "b");
});

test("delete, then the delta list carries the tombstone", async () => {
  const n = await create("r-del");
  const d = await call("DELETE", "/api/notes/delete", { id: n.id });
  assert.equal(d.status, 200);
  assert.deepEqual(d.json, {});

  const again = await call("DELETE", "/api/notes/delete", { id: n.id });
  assert.equal(again.status, 404);
  assert.equal(again.json.code, "not_found");

  const q = new URLSearchParams({ since: n.updated_at, since_id: n.id });
  const l = await call("GET", `/api/notes/list?${q}`);
  assert.equal(l.status, 200);
  const row = (l.json.notes as Note[]).find((x) => x.id === n.id);
  assert.ok(row?.deleted_at, "tombstone travels in delta");
});

test("snapshot paging across tied created_at neither skips nor duplicates", async () => {
  const tied = "2020-01-01T00:00:00.000Z";
  const b = await call("POST", "/api/notes/batch-create", {
    notes: Array.from({ length: 7 }, (_, i) => ({
      client_note_id: `r-tie-${i}`,
      created_at: tied,
    })),
  });
  assert.equal(b.status, 200);
  const made = b.json.created as { client_note_id: string; id: string }[];
  assert.equal(made.length, 7);
  assert.equal(made[0].client_note_id, "r-tie-0");

  const seen: string[] = [];
  let cursor: Note | undefined;
  for (let guard = 0; guard < 20; guard++) {
    const q = new URLSearchParams({ limit: "3" });
    if (cursor) {
      q.set("before", cursor.created_at);
      q.set("before_id", cursor.id);
    } else {
      q.set("before", "2020-01-01T00:00:00.001Z");
    }
    const page = (await call("GET", `/api/notes/list?${q}`)).json
      .notes as Note[];
    seen.push(...page.map((n) => n.id));
    if (page.length < 3) break;
    cursor = page.at(-1);
  }
  assert.equal(seen.length, 7, "no duplicate");
  assert.deepEqual(new Set(seen), new Set(made.map((m) => m.id)), "no skip");
});

test("a bad body is 400 invalid_request", async () => {
  const r = await call("POST", "/api/notes/create", { content: 5 });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "invalid_request");
  assert.equal(typeof r.json.error.message, "string");

  const notJson = await app.request("/api/notes/create", {
    method: "POST",
    body: "{",
  });
  assert.equal(notJson.status, 400);
});

test("unknown folder is 400 folder_not_found; unknown note is 404", async () => {
  const r = await call("POST", "/api/notes/create", {
    client_note_id: "r-fold",
    folder_id: "00000000-0000-4000-8000-000000000000",
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "folder_not_found");

  const u = await call("PATCH", "/api/notes/update", {
    id: "00000000-0000-4000-8000-000000000000",
    content: "x",
  });
  assert.equal(u.status, 404);
  assert.equal(u.json.code, "not_found");
});

test("a malformed since_id or before_id is 400 invalid_request, not 500", async () => {
  for (const q of [
    "since=2026-01-01T00:00:00.000Z&since_id=abc",
    "before=2026-01-01T00:00:00.000Z&before_id=abc",
  ]) {
    const r = await call("GET", `/api/notes/list?${q}`);
    assert.equal(r.status, 400, q);
    assert.equal(r.json.code, "invalid_request", q);
  }
});

test("another owner gets 404 deleting rico's note and does not list it", async () => {
  const n = await create("r-own");
  const ana = asOwner("ana", notesRoutes(db));
  const d = await call("DELETE", "/api/notes/delete", { id: n.id }, ana);
  assert.equal(d.status, 404);
  assert.equal(d.json.code, "not_found");
  const l = await call("GET", "/api/notes/list?limit=200", undefined, ana);
  assert.equal(l.status, 200);
  assert.ok(!(l.json.notes as Note[]).some((x) => x.id === n.id));
  const mine = await call("GET", "/api/notes/list?limit=200");
  assert.ok(
    (mine.json.notes as Note[]).some((x) => x.id === n.id && !x.deleted_at),
  );
});
