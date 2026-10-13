import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "../src/db/client.ts";
import { createFolder, deleteFolder } from "../src/sync/folders.ts";
import {
  batchCreateNotes,
  createNote,
  deleteNote,
  listNotes,
  type Note,
  updateNote,
} from "../src/sync/notes.ts";
import { drain, must, testDb } from "./helpers.ts";

let db: Db;
let client: PGlite;
before(async () => ({ db, client } = await testDb()));
after(async () => client.close());

const OWNER = "rico";

test("create, update, delete, then delta carries the tombstone", async () => {
  const start = new Date(Date.now() - 1).toISOString();
  const n = must(
    await createNote(db, OWNER, {
      client_note_id: "n1",
      title: "T",
      content: "hello",
    }),
  );
  assert.equal(n.user_id, "rico");
  assert.equal(n.updated_by_user_id, "rico");
  assert.equal(n.note_type, "personal");
  assert.equal(n.folder_id, null);
  assert.equal(n.deleted_at, null);

  const u = must(await updateNote(db, OWNER, { id: n.id, content: "edited" }));
  assert.equal(u.content, "edited");
  assert.equal(u.title, "T", "absent field is kept");
  assert.ok(u.updated_at > n.updated_at);

  must(await deleteNote(db, OWNER, n.id));
  assert.deepEqual(await deleteNote(db, OWNER, n.id), {
    ok: false,
    code: "not_found",
  });

  const { notes } = await listNotes(db, OWNER, { mode: "delta", since: start });
  const row = notes.find((x) => x.id === n.id);
  assert.ok(row?.deleted_at, "tombstone travels in delta");
  assert.equal(row.content, "edited");
});

test("a later stored revision than base_updated_at is note_version_conflict with the current row", async () => {
  const n = must(
    await createNote(db, OWNER, { client_note_id: "n-occ", content: "v1" }),
  );
  const v2 = must(
    await updateNote(db, OWNER, {
      id: n.id,
      content: "v2",
      base_updated_at: n.updated_at,
    }),
  );
  const stale = await updateNote(db, OWNER, {
    id: n.id,
    content: "from stale device",
    base_updated_at: n.updated_at,
  });
  assert.ok(!stale.ok && stale.code === "note_version_conflict");
  assert.deepEqual((stale as { note: Note }).note, v2);
  must(
    await updateNote(db, OWNER, {
      id: n.id,
      content: "v3",
      base_updated_at: v2.updated_at,
    }),
  );
});

test("without base_updated_at the last writer wins", async () => {
  const n = must(
    await createNote(db, OWNER, { client_note_id: "n-lww", content: "v1" }),
  );
  must(await updateNote(db, OWNER, { id: n.id, content: "v2" }));
  const last = must(await updateNote(db, OWNER, { id: n.id, content: "v3" }));
  assert.equal(last.content, "v3");
});

test("back-to-back writes still get distinct, increasing revisions", async () => {
  const n = must(
    await createNote(db, OWNER, { client_note_id: "n-fast", content: "0" }),
  );
  const a = must(await updateNote(db, OWNER, { id: n.id, content: "1" }));
  const b = must(await updateNote(db, OWNER, { id: n.id, content: "2" }));
  assert.ok(a.updated_at > n.updated_at && b.updated_at > a.updated_at);
});

test("update of a tombstone or unknown id is not_found", async () => {
  const n = must(await createNote(db, OWNER, { client_note_id: "n-gone" }));
  must(await deleteNote(db, OWNER, n.id));
  assert.deepEqual(await updateNote(db, OWNER, { id: n.id, content: "x" }), {
    ok: false,
    code: "not_found",
  });
  assert.deepEqual(await updateNote(db, OWNER, { id: "nope", content: "x" }), {
    ok: false,
    code: "not_found",
  });
});

test("notes keep a deleted folder's id (no cascade) and refuse an unknown folder", async () => {
  const f = must(
    await createFolder(db, OWNER, { client_folder_id: "nf", name: "NF" }),
  );
  const n = must(
    await createNote(db, OWNER, { client_note_id: "n-in-f", folder_id: f.id }),
  );
  must(await deleteFolder(db, OWNER, f.id));
  const { notes } = await listNotes(db, OWNER, {
    mode: "snapshot",
    limit: 500,
  });
  const row = notes.find((x) => x.id === n.id);
  assert.equal(row?.folder_id, f.id);
  assert.equal(row?.deleted_at, null);
  assert.deepEqual(
    await createNote(db, OWNER, {
      client_note_id: "n-bad-f",
      folder_id: "00000000-0000-4000-8000-000000000000",
    }),
    { ok: false, code: "folder_not_found" },
  );
});

test("batch create returns rows in input order and a retry returns the same ids", async () => {
  const input = [
    { client_note_id: "nb1", content: "a" },
    { client_note_id: "nb2", content: "b" },
  ];
  const first = must(await batchCreateNotes(db, OWNER, input));
  assert.deepEqual(
    first.map((n) => n.client_note_id),
    ["nb1", "nb2"],
  );
  const again = must(await batchCreateNotes(db, OWNER, input));
  assert.deepEqual(
    again.map((n) => n.id),
    first.map((n) => n.id),
  );
});

test("snapshot and delta paging through timestamp ties neither skip nor duplicate", async () => {
  await client.query("delete from notes");
  const tie = "2031-05-05T05:05:05.555Z";
  const made: Note[] = [];
  for (let i = 0; i < 7; i++) {
    made.push(
      must(
        await createNote(db, OWNER, {
          client_note_id: `tie-${i}`,
          created_at: tie,
        }),
      ),
    );
  }
  await client.query("update notes set updated_at = $1", [tie]);
  const want = made.map((n) => n.id).sort();
  const limit = 3;

  const snap = await drain<Note>(async (c) => {
    const rows = (
      await listNotes(db, OWNER, {
        mode: "snapshot",
        limit,
        before: c?.created_at,
        beforeId: c?.id,
      })
    ).notes;
    return { rows, more: rows.length === limit };
  });
  assert.deepEqual(
    snap,
    [...want].reverse(),
    "snapshot: created_at desc, id desc",
  );

  const delta = await drain<Note>(async (c) => {
    const rows = (
      await listNotes(db, OWNER, {
        mode: "delta",
        limit,
        since: c?.updated_at ?? "2000-01-01T00:00:00.000Z",
        sinceId: c?.id,
      })
    ).notes;
    return { rows, more: rows.length === limit };
  });
  assert.deepEqual(delta, want, "delta: updated_at asc, id asc");
});

test("another owner's note is unknown to them; rico still sees it unchanged", async () => {
  const n = must(
    await createNote(db, OWNER, { client_note_id: "n-own", content: "mine" }),
  );
  const ana = await listNotes(db, "ana", { mode: "snapshot", limit: 500 });
  assert.ok(!ana.notes.some((x) => x.id === n.id), "not listed for ana");
  assert.deepEqual(await updateNote(db, "ana", { id: n.id, content: "x" }), {
    ok: false,
    code: "not_found",
  });
  assert.deepEqual(await deleteNote(db, "ana", n.id), {
    ok: false,
    code: "not_found",
  });
  const { notes } = await listNotes(db, OWNER, {
    mode: "snapshot",
    limit: 500,
  });
  assert.deepEqual(
    notes.find((x) => x.id === n.id),
    n,
  );
});

test("two owners may use the same client id; a note cannot use another owner's folder", async () => {
  const r = must(await createNote(db, OWNER, { client_note_id: "n-same" }));
  const a = must(await createNote(db, "ana", { client_note_id: "n-same" }));
  assert.notEqual(a.id, r.id);
  assert.equal(a.user_id, "ana");
  assert.equal(r.user_id, "rico");

  const f = must(
    await createFolder(db, OWNER, { client_folder_id: "nf-own", name: "Own" }),
  );
  assert.deepEqual(
    await createNote(db, "ana", { client_note_id: "n-xf", folder_id: f.id }),
    { ok: false, code: "folder_not_found" },
  );
  assert.deepEqual(await updateNote(db, "ana", { id: a.id, folder_id: f.id }), {
    ok: false,
    code: "folder_not_found",
  });
});
