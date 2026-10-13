import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import type { Hono } from "hono";
import type { Db } from "../src/db/client.ts";
import { dictionaryRoutes } from "../src/routes/dictionary.ts";
import { asOwner, testDb } from "./helpers.ts";

let db: Db;
let client: PGlite;
let app: Hono;
before(async () => {
  ({ db, client } = await testDb());
  app = asOwner("rico", dictionaryRoutes(db));
});
after(async () => client.close());

function send(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function create(client_dict_id: string, word: string, source = "manual") {
  const res = await send("POST", "/api/dictionary/batch-create", {
    entries: [{ client_dict_id, word, source }],
  });
  assert.equal(res.status, 200);
  return (await res.json()).created[0];
}

test("batch-create then list returns the entries in the delta", async () => {
  const start = new Date(Date.now() - 1).toISOString();
  const res = await send("POST", "/api/dictionary/batch-create", {
    entries: [
      { client_dict_id: "d-1", word: "Kubernetes", source: "manual" },
      { client_dict_id: "d-2", word: "PGlite", source: "learned" },
    ],
  });
  assert.equal(res.status, 200);
  const { created } = await res.json();
  assert.deepEqual(
    created.map((e: { word: string; source: string }) => [e.word, e.source]),
    [
      ["Kubernetes", "manual"],
      ["PGlite", "learned"],
    ],
  );
  const list = await app.request(
    `/api/dictionary/list?since=${encodeURIComponent(start)}`,
  );
  assert.equal(list.status, 200);
  const { entries, hasMore } = await list.json();
  assert.equal(hasMore, false);
  for (const c of created)
    assert.ok(entries.some((e: { id: string }) => e.id === c.id));
});

test("update changes word and source", async () => {
  const e = await create("d-up", "teh");
  const res = await send("PATCH", "/api/dictionary/update", {
    id: e.id,
    word: "the",
    source: "learned",
  });
  assert.equal(res.status, 200);
  const u = await res.json();
  assert.equal(u.word, "the");
  assert.equal(u.source, "learned");
  assert.equal(u.client_dict_id, "d-up");
});

test("delete, then the delta carries the tombstone", async () => {
  const start = new Date(Date.now() - 1).toISOString();
  const e = await create("d-del", "gone");
  const del = await send("DELETE", "/api/dictionary/delete", { id: e.id });
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), {});
  const list = await app.request(
    `/api/dictionary/list?since=${encodeURIComponent(start)}`,
  );
  const row = (await list.json()).entries.find(
    (x: { id: string }) => x.id === e.id,
  );
  assert.ok(row, "tombstone travels in delta");
  assert.ok(row.deleted_at);
});

test("paging with limit sets hasMore and since/since_id resumes", async () => {
  const start = new Date(Date.now() - 1).toISOString();
  await create("d-p1", "one");
  await create("d-p2", "two");
  await create("d-p3", "three");
  const since = encodeURIComponent(start);
  const p1 = await (
    await app.request(`/api/dictionary/list?since=${since}&limit=2`)
  ).json();
  assert.equal(p1.entries.length, 2);
  assert.equal(p1.hasMore, true);
  const last = p1.entries[1];
  const p2 = await (
    await app.request(
      `/api/dictionary/list?since=${encodeURIComponent(last.updated_at)}&since_id=${last.id}&limit=2`,
    )
  ).json();
  assert.equal(p2.hasMore, false);
  assert.deepEqual(
    p2.entries.map((e: { word: string }) => e.word),
    ["three"],
  );
});

test("bad source is 400 invalid_request", async () => {
  const res = await send("POST", "/api/dictionary/batch-create", {
    entries: [{ client_dict_id: "d-bad", word: "x", source: "guessed" }],
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "invalid_request");
  const up = await send("PATCH", "/api/dictionary/update", {
    id: "00000000-0000-0000-0000-000000000000",
    source: "guessed",
  });
  assert.equal(up.status, 400);
});

test("unknown id is 404 not_found for update and delete", async () => {
  const id = "00000000-0000-0000-0000-000000000000";
  const up = await send("PATCH", "/api/dictionary/update", { id, word: "x" });
  assert.equal(up.status, 404);
  assert.equal((await up.json()).code, "not_found");
  const del = await send("DELETE", "/api/dictionary/delete", { id });
  assert.equal(del.status, 404);
  assert.equal((await del.json()).code, "not_found");
});

test("a malformed since_id is 400 invalid_request, not 500", async () => {
  const res = await app.request(
    "/api/dictionary/list?since=2026-01-01T00:00:00.000Z&since_id=abc",
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "invalid_request");
});

test("a since_id without since is 400 invalid_request", async () => {
  const res = await app.request(
    "/api/dictionary/list?since_id=00000000-0000-4000-8000-000000000000",
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "invalid_request");
});

test("another owner gets 404 deleting rico's row and does not list it", async () => {
  const e = await create("d-own", "private");
  const ana = asOwner("ana", dictionaryRoutes(db));
  const del = await ana.request("/api/dictionary/delete", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: e.id }),
  });
  assert.equal(del.status, 404);
  assert.equal((await del.json()).code, "not_found");
  const list = await (await ana.request("/api/dictionary/list")).json();
  assert.ok(!list.entries.some((x: { id: string }) => x.id === e.id));
  const mine = await (await app.request("/api/dictionary/list")).json();
  const row = mine.entries.find((x: { id: string }) => x.id === e.id);
  assert.ok(row && !row.deleted_at, "rico's row still live");
});
