import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "../src/db/client.ts";
import { foldersRoutes } from "../src/routes/folders.ts";
import { asOwner, testDb } from "./helpers.ts";

let db: Db;
let client: PGlite;
let app: ReturnType<typeof asOwner>;
before(async () => {
  ({ db, client } = await testDb());
  app = asOwner("rico", foldersRoutes(db));
});
after(async () => client.close());

function send(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("create, then list delta carries the tombstone after DELETE with a JSON body", async () => {
  const start = new Date(Date.now() - 1).toISOString();
  const res = await send("POST", "/api/folders/create", {
    client_folder_id: "r-work",
    name: "Work",
    sort_order: 3,
  });
  assert.equal(res.status, 200);
  const f = await res.json();
  assert.equal(f.name, "Work");
  assert.equal(f.sort_order, 3);
  assert.equal(f.deleted_at, null);

  const del = await send("DELETE", "/api/folders/delete", { id: f.id });
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), {});

  const again = await send("DELETE", "/api/folders/delete", { id: f.id });
  assert.equal(again.status, 404);
  assert.equal((await again.json()).code, "not_found");

  const list = await app.request(
    `/api/folders/list?since=${encodeURIComponent(start)}`,
  );
  assert.equal(list.status, 200);
  const { folders } = await list.json();
  const row = folders.find((x: { id: string }) => x.id === f.id);
  assert.ok(row, "tombstone travels in delta");
  assert.ok(row.deleted_at);
});

test("batch-create returns created rows in input order", async () => {
  const res = await send("POST", "/api/folders/batch-create", {
    folders: [
      { client_folder_id: "r-b1", name: "B1" },
      { client_folder_id: "r-b2", name: "B2" },
    ],
  });
  assert.equal(res.status, 200);
  const { created } = await res.json();
  assert.deepEqual(
    created.map((x: { name: string }) => x.name),
    ["B1", "B2"],
  );
});

test("rename onto a live name is 409 folder_name_taken in the envelope", async () => {
  await send("POST", "/api/folders/create", {
    client_folder_id: "r-a",
    name: "Alpha",
  });
  const b = await (
    await send("POST", "/api/folders/create", {
      client_folder_id: "r-bb",
      name: "Beta",
    })
  ).json();
  const res = await send("PATCH", "/api/folders/update", {
    id: b.id,
    name: "Alpha",
  });
  assert.equal(res.status, 409);
  const err = await res.json();
  assert.equal(err.code, "folder_name_taken");
  assert.equal(typeof err.error.message, "string");
});

test("creating a default whose name matches the existing default adopts it", async () => {
  const first = await (
    await send("POST", "/api/folders/create", {
      client_folder_id: "desk-personal",
      name: "Personal",
      is_default: true,
    })
  ).json();
  const res = await send("POST", "/api/folders/create", {
    client_folder_id: "phone-personal",
    name: "Personal",
    is_default: true,
  });
  assert.equal(res.status, 200);
  const adopted = await res.json();
  assert.equal(adopted.id, first.id);
  assert.equal(adopted.client_folder_id, "desk-personal");
});

test("update of an unknown id is 404 not_found", async () => {
  const res = await send("PATCH", "/api/folders/update", {
    id: "00000000-0000-4000-8000-000000000000",
    name: "Ghost",
  });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, "not_found");
});

test("a bad body is 400 invalid_request", async () => {
  const missing = await send("POST", "/api/folders/create", { name: "No id" });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).code, "invalid_request");

  const notJson = await app.request("/api/folders/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{nope",
  });
  assert.equal(notJson.status, 400);

  const badSince = await app.request("/api/folders/list?since=yesterday");
  assert.equal(badSince.status, 400);
  assert.equal((await badSince.json()).code, "invalid_request");
});

test("another owner gets 404 deleting rico's folder and does not list it", async () => {
  const f = await (
    await send("POST", "/api/folders/create", {
      client_folder_id: "r-owned",
      name: "Owned",
    })
  ).json();
  const ana = asOwner("ana", foldersRoutes(db));
  const del = await ana.request("/api/folders/delete", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: f.id }),
  });
  assert.equal(del.status, 404);
  assert.equal((await del.json()).code, "not_found");
  const list = await ana.request("/api/folders/list");
  assert.equal(list.status, 200);
  const { folders } = await list.json();
  assert.ok(!folders.some((x: { id: string }) => x.id === f.id));
});
