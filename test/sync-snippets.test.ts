import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "../src/db/client.ts";
import {
  batchCreateSnippets,
  deleteSnippet,
  listSnippets,
  type SnippetEntry,
  updateSnippet,
} from "../src/sync/snippets.ts";
import { drain, must, testDb } from "./helpers.ts";

let db: Db;
let client: PGlite;
before(async () => ({ db, client } = await testDb()));
after(async () => client.close());

test("create, update, delete, then delta carries the tombstone", async () => {
  const [s] = must(
    await batchCreateSnippets(db, "rico", [
      { client_snippet_id: "s1", trigger: ";sig", replacement: "Rico" },
    ]),
  );
  const u = must(
    await updateSnippet(db, "rico", { id: s.id, replacement: "-- Rico" }),
  );
  assert.equal(u.trigger, ";sig");
  assert.equal(u.replacement, "-- Rico");
  must(await deleteSnippet(db, "rico", s.id));
  assert.deepEqual(await deleteSnippet(db, "rico", s.id), {
    ok: false,
    code: "not_found",
  });
  assert.deepEqual(
    await updateSnippet(db, "rico", { id: s.id, replacement: "x" }),
    {
      ok: false,
      code: "not_found",
    },
  );
  const { entries } = await listSnippets(db, "rico", {
    mode: "delta",
    since: s.updated_at,
  });
  const row = entries.find((e) => e.id === s.id);
  assert.ok(row?.deleted_at, "tombstone travels in delta");
});

test("a trigger another live snippet uses is snippet_trigger_taken; a tombstone frees it", async () => {
  const [a, b] = must(
    await batchCreateSnippets(db, "rico", [
      { client_snippet_id: "ta", trigger: ";addr", replacement: "1 Main St" },
      { client_snippet_id: "tb", trigger: ";ph", replacement: "555" },
    ]),
  );
  assert.deepEqual(
    await updateSnippet(db, "rico", { id: b.id, trigger: ";addr" }),
    {
      ok: false,
      code: "snippet_trigger_taken",
    },
  );
  assert.deepEqual(
    await batchCreateSnippets(db, "rico", [
      { client_snippet_id: "tc", trigger: ";addr", replacement: "dup" },
    ]),
    { ok: false, code: "snippet_trigger_taken" },
  );
  must(
    await updateSnippet(db, "rico", {
      id: a.id,
      trigger: ";addr",
      replacement: "same row",
    }),
  );
  must(await deleteSnippet(db, "rico", a.id));
  must(await updateSnippet(db, "rico", { id: b.id, trigger: ";addr" }));
});

test("snapshot (cursor) and delta (since) paging through ties neither skip nor duplicate", async () => {
  await client.query("delete from snippets");
  const tie = "2031-02-02T02:02:02.222Z";
  const made = must(
    await batchCreateSnippets(
      db,
      "rico",
      Array.from({ length: 5 }, (_, i) => ({
        client_snippet_id: `p${i}`,
        trigger: `;p${i}`,
        replacement: `${i}`,
        created_at: tie,
      })),
    ),
  );
  await client.query("update snippets set updated_at = $1", [tie]);
  const want = made.map((s) => s.id).sort();

  const snap = await drain<SnippetEntry>(async (c) => {
    const r = await listSnippets(db, "rico", {
      mode: "snapshot",
      limit: 2,
      cursor: c?.created_at,
      cursorId: c?.id,
    });
    return { rows: r.entries, more: r.hasMore };
  });
  assert.deepEqual(snap, [...want].reverse());

  const delta = await drain<SnippetEntry>(async (c) => {
    const r = await listSnippets(db, "rico", {
      mode: "delta",
      limit: 2,
      since: c?.updated_at,
      sinceId: c?.id,
    });
    return { rows: r.entries, more: r.hasMore };
  });
  assert.deepEqual(delta, want);
});

test("another owner's snippet is an unknown id; owners share client ids and triggers", async () => {
  const [s] = must(
    await batchCreateSnippets(db, "rico", [
      { client_snippet_id: "own-1", trigger: ";own", replacement: "rico's" },
    ]),
  );
  const anaList = await listSnippets(db, "ana", {
    mode: "snapshot",
    limit: 500,
  });
  assert.ok(!anaList.entries.some((e) => e.id === s.id));
  const unknown = "00000000-0000-0000-0000-000000000000";
  assert.deepEqual(
    await updateSnippet(db, "ana", { id: s.id, replacement: "x" }),
    await updateSnippet(db, "ana", { id: unknown, replacement: "x" }),
  );
  assert.deepEqual(await deleteSnippet(db, "ana", s.id), {
    ok: false,
    code: "not_found",
  });
  assert.deepEqual(
    await deleteSnippet(db, "ana", s.id),
    await deleteSnippet(db, "ana", unknown),
  );
  const ricoList = await listSnippets(db, "rico", {
    mode: "snapshot",
    limit: 500,
  });
  const mine = ricoList.entries.find((e) => e.id === s.id);
  assert.equal(mine?.replacement, "rico's");
  assert.equal(mine?.deleted_at, null);

  const [a] = must(
    await batchCreateSnippets(db, "ana", [
      { client_snippet_id: "own-1", trigger: ";own", replacement: "ana's" },
    ]),
  );
  assert.notEqual(a.id, s.id);
  assert.equal(a.replacement, "ana's");
});
