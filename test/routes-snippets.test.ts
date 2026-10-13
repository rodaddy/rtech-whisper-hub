import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "../src/db/client.ts";
import { snippetsRoutes } from "../src/routes/snippets.ts";
import { asOwner, testDb } from "./helpers.ts";

let db: Db;
let client: PGlite;
let app: ReturnType<typeof asOwner>;
before(async () => {
  ({ db, client } = await testDb());
  app = asOwner("rico", snippetsRoutes(db));
});
after(async () => client.close());

function send(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function create(id: string, trigger: string) {
  const res = await send("POST", "/api/snippets/batch-create", {
    entries: [{ client_snippet_id: id, trigger, replacement: `${trigger}!` }],
  });
  assert.equal(res.status, 200);
  return (await res.json()).created[0];
}

test("batch-create then snapshot list returns the rows", async () => {
  const res = await send("POST", "/api/snippets/batch-create", {
    entries: [
      {
        client_snippet_id: "s-1",
        trigger: "brb",
        replacement: "be right back",
      },
      { client_snippet_id: "s-2", trigger: "omw", replacement: "on my way" },
    ],
  });
  assert.equal(res.status, 200);
  const { created } = await res.json();
  assert.deepEqual(
    created.map((x: { trigger: string }) => x.trigger),
    ["brb", "omw"],
  );

  const list = await app.request("/api/snippets/list?limit=500");
  assert.equal(list.status, 200);
  const page = await list.json();
  assert.equal(page.hasMore, false);
  const triggers = page.entries.map((x: { trigger: string }) => x.trigger);
  assert.ok(triggers.includes("brb") && triggers.includes("omw"));

  const one = await (await app.request("/api/snippets/list?limit=1")).json();
  assert.equal(one.entries.length, 1);
  assert.equal(one.hasMore, true);
});

test("delta list after an update carries the new replacement", async () => {
  const s = await create("s-upd", "ty");
  const since = s.updated_at;
  const upd = await send("PATCH", "/api/snippets/update", {
    id: s.id,
    replacement: "thank you",
  });
  assert.equal(upd.status, 200);
  const list = await app.request(
    `/api/snippets/list?since=${encodeURIComponent(since)}&since_id=${s.id}`,
  );
  assert.equal(list.status, 200);
  const { entries } = await list.json();
  const row = entries.find((x: { id: string }) => x.id === s.id);
  assert.ok(row, "updated row travels in delta");
  assert.equal(row.replacement, "thank you");
});

test("rename onto a live trigger is 409 snippet_trigger_taken", async () => {
  await create("s-a", "addr");
  const b = await create("s-b", "sig");
  const res = await send("PATCH", "/api/snippets/update", {
    id: b.id,
    trigger: "addr",
  });
  assert.equal(res.status, 409);
  const err = await res.json();
  assert.equal(err.code, "snippet_trigger_taken");
  assert.equal(typeof err.error.message, "string");
});

test("delete, then the delta carries the tombstone", async () => {
  const s = await create("s-del", "gone");
  const del = await send("DELETE", "/api/snippets/delete", { id: s.id });
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), {});

  const again = await send("DELETE", "/api/snippets/delete", { id: s.id });
  assert.equal(again.status, 404);
  assert.equal((await again.json()).code, "not_found");

  const list = await app.request(
    `/api/snippets/list?since=${encodeURIComponent(s.updated_at)}&since_id=${s.id}`,
  );
  const { entries } = await list.json();
  const row = entries.find((x: { id: string }) => x.id === s.id);
  assert.ok(row, "tombstone travels in delta");
  assert.ok(row.deleted_at);
});

test("mixed snapshot and delta params, or a bad body, is 400", async () => {
  const mixed = await app.request(
    `/api/snippets/list?cursor=${encodeURIComponent(new Date().toISOString())}&since=${encodeURIComponent(new Date().toISOString())}`,
  );
  assert.equal(mixed.status, 400);
  assert.equal((await mixed.json()).code, "invalid_request");

  const bad = await send("POST", "/api/snippets/batch-create", {
    entries: [{ trigger: "x" }],
  });
  assert.equal(bad.status, 400);
});

test("a malformed cursor_id or since_id is 400 invalid_request, not 500", async () => {
  for (const q of [
    "cursor=2026-01-01T00:00:00.000Z&cursor_id=abc",
    "since=2026-01-01T00:00:00.000Z&since_id=abc",
  ]) {
    const res = await app.request(`/api/snippets/list?${q}`);
    assert.equal(res.status, 400, q);
    assert.equal((await res.json()).code, "invalid_request", q);
  }
});

test("a cursor_id without cursor, or since_id without since, is 400 invalid_request", async () => {
  const id = "00000000-0000-4000-8000-000000000000";
  for (const q of [`cursor_id=${id}`, `since_id=${id}`]) {
    const res = await app.request(`/api/snippets/list?${q}`);
    assert.equal(res.status, 400, q);
    assert.equal((await res.json()).code, "invalid_request", q);
  }
});

test("another owner gets 404 deleting rico's snippet and does not list it", async () => {
  const s = await create("s-owned", "mine");
  const ana = asOwner("ana", snippetsRoutes(db));
  const del = await ana.request("/api/snippets/delete", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: s.id }),
  });
  assert.equal(del.status, 404);
  assert.equal((await del.json()).code, "not_found");
  const list = await (await ana.request("/api/snippets/list?limit=500")).json();
  assert.ok(!list.entries.some((x: { id: string }) => x.id === s.id));
  const own = await (await app.request("/api/snippets/list?limit=500")).json();
  assert.ok(own.entries.some((x: { id: string }) => x.id === s.id));
});
