import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "../src/db/client.ts";
import {
  batchCreateFolders,
  createFolder,
  deleteFolder,
  listFolders,
  updateFolder,
} from "../src/sync/folders.ts";
import { must, testDb } from "./helpers.ts";

let db: Db;
let client: PGlite;
before(async () => ({ db, client } = await testDb()));
after(async () => client.close());

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test("create, update, delete, then delta carries the tombstone", async () => {
  const start = new Date(Date.now() - 1);
  const f = must(
    await createFolder(db, "rico", {
      client_folder_id: "c-work",
      name: "Work",
      sort_order: 2,
    }),
  );
  assert.equal(f.name, "Work");
  assert.equal(f.is_default, false);
  assert.equal(f.workspace_id, null);
  assert.match(f.created_at, ISO_MS);
  assert.match(f.updated_at, ISO_MS);

  const u = must(await updateFolder(db, "rico", { id: f.id, name: "Job" }));
  assert.equal(u.name, "Job");
  assert.equal(u.sort_order, 2, "absent field is kept");
  assert.ok(u.updated_at > f.updated_at, "update bumps updated_at");

  assert.deepEqual(await deleteFolder(db, "rico", f.id), {
    ok: true,
    value: {},
  });
  assert.deepEqual(await deleteFolder(db, "rico", f.id), {
    ok: false,
    code: "not_found",
  });

  const { folders } = await listFolders(db, "rico", { since: start });
  const row = folders.find((x) => x.id === f.id);
  assert.ok(row, "tombstone travels in delta");
  assert.match(row.deleted_at ?? "", ISO_MS);
  assert.ok(row.updated_at > u.updated_at, "delete bumps updated_at");
});

test("hub keeps a client created_at and stamps one when absent", async () => {
  const given = "2024-01-02T03:04:05.678Z";
  const f = must(
    await createFolder(db, "rico", {
      client_folder_id: "c-old",
      name: "Old",
      created_at: given,
    }),
  );
  assert.equal(f.created_at, given);
  assert.notEqual(f.updated_at, given);
});

test("a live name clash is folder_name_taken on create and rename; a tombstone frees the name", async () => {
  const a = must(
    await createFolder(db, "rico", { client_folder_id: "c-a", name: "Ideas" }),
  );
  assert.deepEqual(
    await createFolder(db, "rico", { client_folder_id: "c-b", name: "Ideas" }),
    { ok: false, code: "folder_name_taken" },
  );
  const b = must(
    await createFolder(db, "rico", { client_folder_id: "c-b", name: "Other" }),
  );
  assert.deepEqual(
    await updateFolder(db, "rico", { id: b.id, name: "Ideas" }),
    {
      ok: false,
      code: "folder_name_taken",
    },
  );
  must(
    await updateFolder(db, "rico", { id: a.id, name: "Ideas", sort_order: 5 }),
  );
  must(await deleteFolder(db, "rico", a.id));
  must(await updateFolder(db, "rico", { id: b.id, name: "Ideas" }));
});

test("creating a default whose name matches a live default adopts the existing row", async () => {
  const first = must(
    await createFolder(db, "rico", {
      client_folder_id: "mac-personal",
      name: "Personal",
      is_default: true,
    }),
  );
  const second = must(
    await createFolder(db, "rico", {
      client_folder_id: "phone-personal",
      name: "Personal",
      is_default: true,
    }),
  );
  assert.equal(second.id, first.id);
  assert.equal(second.client_folder_id, "mac-personal");
  assert.deepEqual(
    await createFolder(db, "rico", {
      client_folder_id: "phone-x",
      name: "Personal",
    }),
    { ok: false, code: "folder_name_taken" },
    "a non-default create still clashes",
  );
});

test("batch create keeps input order and rolls back on a clash", async () => {
  const r = must(
    await batchCreateFolders(db, "rico", [
      { client_folder_id: "b1", name: "B1" },
      { client_folder_id: "b2", name: "B2" },
    ]),
  );
  assert.deepEqual(
    r.map((f) => f.client_folder_id),
    ["b1", "b2"],
  );
  assert.deepEqual(
    await batchCreateFolders(db, "rico", [
      { client_folder_id: "b3", name: "B3" },
      { client_folder_id: "b4", name: "B1" },
    ]),
    { ok: false, code: "folder_name_taken" },
  );
  const { folders } = await listFolders(db, "rico");
  assert.ok(
    !folders.some((f) => f.client_folder_id === "b3"),
    "batch rolled back",
  );
});

test("a retried create with the same client id returns the first row", async () => {
  const a = must(
    await createFolder(db, "rico", {
      client_folder_id: "retry",
      name: "Retry",
    }),
  );
  const b = must(
    await createFolder(db, "rico", {
      client_folder_id: "retry",
      name: "Retry",
    }),
  );
  assert.equal(b.id, a.id);
});

test("update of a tombstone or unknown id is not_found", async () => {
  const f = must(
    await createFolder(db, "rico", {
      client_folder_id: "c-gone",
      name: "Gone",
    }),
  );
  must(await deleteFolder(db, "rico", f.id));
  assert.deepEqual(await updateFolder(db, "rico", { id: f.id, name: "Back" }), {
    ok: false,
    code: "not_found",
  });
  assert.deepEqual(
    await updateFolder(db, "rico", {
      id: "00000000-0000-4000-8000-000000000000",
      name: "X",
    }),
    { ok: false, code: "not_found" },
  );
  assert.deepEqual(await deleteFolder(db, "rico", "not-a-uuid"), {
    ok: false,
    code: "not_found",
  });
});

test("delta with since_id pages through updated_at ties without skip or duplicate", async () => {
  const made = [];
  for (let i = 0; i < 5; i++) {
    made.push(
      must(
        await createFolder(db, "rico", {
          client_folder_id: `tie-${i}`,
          name: `Tie ${i}`,
        }),
      ),
    );
  }
  const tie = "2030-01-01T00:00:00.000Z";
  await client.query(
    `update folders set updated_at = $1 where client_folder_id like 'tie-%'`,
    [tie],
  );
  const { folders: all } = await listFolders(db, "rico", {
    since: "2029-12-31T23:59:59.999Z",
  });
  assert.equal(all.length, 5);
  const ids = all.map((f) => f.id);
  assert.deepEqual(ids, [...ids].sort(), "ties ordered by id");
  const after2 = await listFolders(db, "rico", { since: tie, sinceId: ids[1] });
  assert.deepEqual(
    after2.folders.map((f) => f.id),
    ids.slice(2),
  );
});

test("another owner's folder is unknown: not listed, update and delete are not_found", async () => {
  const f = must(
    await createFolder(db, "rico", { client_folder_id: "own-1", name: "Mine" }),
  );
  const { folders: anas } = await listFolders(db, "ana");
  assert.ok(!anas.some((x) => x.id === f.id), "not listed for ana");
  assert.deepEqual(await updateFolder(db, "ana", { id: f.id, name: "Hers" }), {
    ok: false,
    code: "not_found",
  });
  assert.deepEqual(await deleteFolder(db, "ana", f.id), {
    ok: false,
    code: "not_found",
  });
  const { folders: ricos } = await listFolders(db, "rico");
  const row = ricos.find((x) => x.id === f.id);
  assert.ok(row, "rico still sees it");
  assert.equal(row.name, "Mine");
  assert.equal(row.deleted_at, null);
  assert.equal(row.updated_at, f.updated_at, "unchanged");
});

test("two owners may share a client id and a live folder name", async () => {
  const r = must(
    await createFolder(db, "rico", {
      client_folder_id: "shared",
      name: "Shared",
    }),
  );
  const a = must(
    await createFolder(db, "ana", {
      client_folder_id: "shared",
      name: "Shared",
    }),
  );
  assert.notEqual(a.id, r.id, "ana gets her own row, not rico's retry");
});
