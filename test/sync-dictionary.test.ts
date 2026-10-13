import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "../src/db/client.ts";
import {
  batchCreateDictionary,
  deleteDictionaryEntry,
  type DictionaryEntry,
  listDictionary,
  updateDictionaryEntry,
} from "../src/sync/dictionary.ts";
import { drain, must, testDb } from "./helpers.ts";

let db: Db;
let client: PGlite;
before(async () => ({ db, client } = await testDb()));
after(async () => client.close());

test("create, update, delete, then delta carries the tombstone", async () => {
  const clientStamp = "2020-01-01T00:00:00.000Z";
  const [e] = must(
    await batchCreateDictionary(db, "rico", [
      {
        client_dict_id: "d1",
        word: "Kubernetes",
        created_at: clientStamp,
        updated_at: clientStamp,
      },
    ]),
  );
  assert.equal(e.source, "manual");
  assert.equal(e.created_at, clientStamp, "client created_at kept");
  assert.notEqual(e.updated_at, clientStamp, "client updated_at ignored");

  const u = must(
    await updateDictionaryEntry(db, "rico", { id: e.id, source: "learned" }),
  );
  assert.equal(u.word, "Kubernetes");
  assert.equal(u.source, "learned");

  must(await deleteDictionaryEntry(db, "rico", e.id));
  assert.deepEqual(await deleteDictionaryEntry(db, "rico", e.id), {
    ok: false,
    code: "not_found",
  });
  assert.deepEqual(
    await updateDictionaryEntry(db, "rico", { id: e.id, word: "x" }),
    {
      ok: false,
      code: "not_found",
    },
  );

  const { entries, hasMore } = await listDictionary(db, "rico", {
    since: u.updated_at,
    sinceId: u.id,
  });
  assert.equal(hasMore, false);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, e.id);
  assert.ok(entries[0].deleted_at);
});

test("paging through updated_at ties neither skips nor duplicates, and hasMore ends the pass", async () => {
  await client.query("delete from dictionary_entries");
  const made = must(
    await batchCreateDictionary(
      db,
      "rico",
      Array.from({ length: 5 }, (_, i) => ({
        client_dict_id: `w${i}`,
        word: `w${i}`,
      })),
    ),
  );
  await client.query("update dictionary_entries set updated_at = $1", [
    "2031-01-01T00:00:00.000Z",
  ]);
  const pages: boolean[] = [];
  const seen = await drain<DictionaryEntry>(async (c) => {
    const r = await listDictionary(db, "rico", {
      limit: 2,
      since: c?.updated_at,
      sinceId: c?.id,
    });
    pages.push(r.hasMore);
    return { rows: r.entries, more: r.hasMore };
  });
  assert.deepEqual(seen, made.map((e) => e.id).sort());
  assert.deepEqual(pages, [true, true, false]);
});

test("another owner cannot see, update or delete a row; client ids are per owner", async () => {
  const [e] = must(
    await batchCreateDictionary(db, "rico", [
      { client_dict_id: "own-1", word: "mine" },
    ]),
  );
  const ana = await listDictionary(db, "ana");
  assert.ok(!ana.entries.some((x) => x.id === e.id), "not listed for ana");
  const notFound = { ok: false, code: "not_found" };
  assert.deepEqual(
    await updateDictionaryEntry(db, "ana", { id: e.id, word: "stolen" }),
    notFound,
  );
  assert.deepEqual(await deleteDictionaryEntry(db, "ana", e.id), notFound);
  const rico = await listDictionary(db, "rico");
  const still = rico.entries.find((x) => x.id === e.id);
  assert.deepEqual(still, e, "rico's row unchanged");

  const [a] = must(
    await batchCreateDictionary(db, "ana", [
      { client_dict_id: "own-1", word: "hers" },
    ]),
  );
  assert.notEqual(a.id, e.id, "same client id makes ana her own row");
  assert.equal(a.word, "hers");
});
