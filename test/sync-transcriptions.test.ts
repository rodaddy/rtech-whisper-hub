import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Db } from "../src/db/client.ts";
import {
  batchCreateTranscriptions,
  batchDeleteTranscriptions,
  createTranscription,
  deleteTranscription,
  listTranscriptions,
  listLiveTranscriptions,
  type Transcription,
} from "../src/sync/transcriptions.ts";
import { drain, testDb } from "./helpers.ts";

let db: Db;
let client: PGlite;
before(async () => ({ db, client } = await testDb()));
after(async () => client.close());

test("create, batch-delete, then delta carries the tombstones", async () => {
  const t = await createTranscription(db, "rico", {
    client_transcription_id: "t1",
    text: "hello world",
    audio_duration_ms: 1500,
  });
  assert.equal(t.status, "completed");
  assert.equal(t.raw_text, null);
  const [u] = await batchCreateTranscriptions(db, "rico", [
    {
      client_transcription_id: "t2",
      text: "second",
      created_at: "2025-06-01T12:00:00.123Z",
    },
  ]);
  assert.equal(u.created_at, "2025-06-01T12:00:00.123Z");

  const res = await batchDeleteTranscriptions(db, "rico", [
    t.id,
    "not-a-uuid",
    u.id,
    t.id,
  ]);
  assert.deepEqual(res.deleted.sort(), [t.id, u.id].sort());
  assert.deepEqual(
    await batchDeleteTranscriptions(db, "rico", [t.id]),
    { deleted: [] },
    "already deleted",
  );

  const { transcriptions } = await listTranscriptions(db, "rico", {
    mode: "delta",
    since: new Date(Date.parse(t.updated_at) - 1),
  });
  assert.deepEqual(
    transcriptions.map((x) => [x.id, x.deleted_at !== null]).sort(),
    [
      [t.id, true],
      [u.id, true],
    ].sort(),
  );
});

test("snapshot and delta paging through ties neither skip nor duplicate", async () => {
  await client.query("delete from transcriptions");
  const tie = "2031-03-03T03:03:03.333Z";
  const made = await batchCreateTranscriptions(
    db,
    "rico",
    Array.from({ length: 5 }, (_, i) => ({
      client_transcription_id: `x${i}`,
      text: `${i}`,
      created_at: tie,
    })),
  );
  await client.query("update transcriptions set updated_at = $1", [tie]);
  const want = made.map((x) => x.id).sort();
  const limit = 2;

  const snap = await drain<Transcription>(async (c) => {
    const rows = (
      await listTranscriptions(db, "rico", {
        mode: "snapshot",
        limit,
        before: c?.created_at,
        beforeId: c?.id,
      })
    ).transcriptions;
    return { rows, more: rows.length === limit };
  });
  assert.deepEqual(snap, [...want].reverse());

  const delta = await drain<Transcription>(async (c) => {
    const rows = (
      await listTranscriptions(db, "rico", {
        mode: "delta",
        limit,
        since: c?.updated_at,
        sinceId: c?.id,
      })
    ).transcriptions;
    return { rows, more: rows.length === limit };
  });
  assert.deepEqual(delta, want);
});

test("batch-delete in the same millisecond stamps the tombstone after the create", async (t) => {
  const frozen = Date.parse("2032-02-02T02:02:02.222Z");
  t.mock.method(Date, "now", () => frozen);
  const made = await createTranscription(db, "rico", {
    client_transcription_id: "same-ms",
    text: "x",
  });
  const { deleted } = await batchDeleteTranscriptions(db, "rico", [made.id]);
  assert.deepEqual(deleted, [made.id]);
  const { transcriptions } = await listTranscriptions(db, "rico", {
    mode: "delta",
    since: made.updated_at,
    sinceId: made.id,
  });
  const tomb = transcriptions.find((x) => x.id === made.id);
  assert.ok(tomb, "the tombstone is after the client's (stamp, id) cursor");
  assert.ok(tomb.updated_at > made.updated_at);
});

test("batch-delete stamps each row after its own last stamp in one pass", async (t) => {
  await client.query("delete from transcriptions");
  const frozen = Date.parse("2033-03-03T03:03:03.333Z");
  t.mock.method(Date, "now", () => frozen);
  const [past, future] = await batchCreateTranscriptions(db, "rico", [
    { client_transcription_id: "past", text: "p" },
    { client_transcription_id: "future", text: "f" },
  ]);
  const ahead = "2040-01-01T00:00:00.000Z";
  await client.query(
    "update transcriptions set updated_at = $1 where id = $2",
    [ahead, future.id],
  );
  const past0 = "2020-01-01T00:00:00.000Z";
  await client.query(
    "update transcriptions set updated_at = $1 where id = $2",
    [past0, past.id],
  );
  const { deleted } = await batchDeleteTranscriptions(db, "rico", [
    past.id,
    future.id,
  ]);
  assert.deepEqual(deleted.sort(), [past.id, future.id].sort());
  const { transcriptions } = await listTranscriptions(db, "rico", {
    mode: "delta",
    since: "2000-01-01T00:00:00.000Z",
  });
  const byId = new Map(transcriptions.map((x) => [x.id, x]));
  const p = byId.get(past.id)!;
  const f = byId.get(future.id)!;
  assert.equal(p.updated_at, new Date(frozen).toISOString(), "clock wins");
  assert.equal(p.deleted_at, p.updated_at);
  assert.equal(f.updated_at, "2040-01-01T00:00:00.001Z", "last stamp + 1ms");
  assert.equal(f.deleted_at, f.updated_at);
});

test("a mixed batch-delete returns each live id once and leaves tombstones untouched", async () => {
  const [live, dead] = await batchCreateTranscriptions(db, "rico", [
    { client_transcription_id: "mix-live", text: "live" },
    { client_transcription_id: "mix-dead", text: "dead" },
  ]);
  await batchDeleteTranscriptions(db, "rico", [dead.id]);
  const before = (
    await listTranscriptions(db, "rico", {
      mode: "delta",
      since: "2000-01-01T00:00:00.000Z",
    })
  ).transcriptions.find((x) => x.id === dead.id)!;
  assert.ok(before.deleted_at);

  const unknown = "00000000-0000-4000-8000-000000000000";
  const res = await batchDeleteTranscriptions(db, "rico", [
    live.id,
    dead.id,
    unknown,
    live.id,
    dead.id,
  ]);
  assert.deepEqual(res, { deleted: [live.id] });

  const after = (
    await listTranscriptions(db, "rico", {
      mode: "delta",
      since: "2000-01-01T00:00:00.000Z",
    })
  ).transcriptions;
  const d = after.find((x) => x.id === dead.id)!;
  assert.equal(d.updated_at, before.updated_at, "tombstone keeps its stamp");
  assert.equal(d.deleted_at, before.deleted_at);
  assert.ok(after.find((x) => x.id === live.id)!.deleted_at);
  assert.equal(
    after.some((x) => x.id === unknown),
    false,
  );
});

// PGlite is one connection, so two overlapping batch-deletes cannot race here
// and no behavioural test can catch a 40P01 regression (#52, #71). Pin the SQL
// shape instead: an id-ordered SELECT ... FOR UPDATE, then the UPDATE, both
// inside one transaction.
test("batch-delete pre-locks rows in id order before the UPDATE, in one transaction", async () => {
  const { db: fresh, client: pg } = await testDb();
  const log: string[] = [];
  const params: unknown[][] = [];
  const spied = drizzle(pg, {
    logger: {
      logQuery: (query, p) => {
        log.push(query);
        params.push(p);
      },
    },
  }) as unknown as Db;
  const [a, b] = await batchCreateTranscriptions(fresh, "rico", [
    { client_transcription_id: "lock-a", text: "a" },
    { client_transcription_id: "lock-b", text: "b" },
  ]);
  const transaction = pg.transaction.bind(pg);
  pg.transaction = (async (fn: Parameters<typeof transaction>[0]) => {
    log.push("BEGIN");
    const out = await transaction(fn);
    log.push("COMMIT");
    return out;
  }) as typeof pg.transaction;
  try {
    const res = await batchDeleteTranscriptions(spied, "rico", [
      b.id,
      a.id,
      b.id,
      "not-a-uuid",
    ]);
    assert.equal(res.deleted.length, 2);
  } finally {
    pg.transaction = transaction;
    await pg.close();
  }
  assert.equal(log.length, 4, log.join("\n"));
  assert.equal(log[0], "BEGIN");
  assert.match(
    log[1],
    /^select .* from "transcriptions" where .* order by "transcriptions"\."id" for update$/,
  );
  assert.match(log[2], /^update "transcriptions" set /);
  assert.equal(log[3], "COMMIT");
  // The lock must cover exactly the rows the UPDATE touches (#84): a narrower
  // lock predicate would let overlapping batch-deletes lock in plan order again.
  const whereOf = (sqlText: string) =>
    sqlText
      .match(/ where (.*?) (order by|returning|for update)/)?.[1]
      ?.replace(/\$\d+/g, "$?") // placeholders are numbered per statement
      .replace(/\s+/g, " ")
      .trim();
  const lockWhere = whereOf(log[1]);
  assert.ok(lockWhere, log[1]);
  assert.equal(lockWhere, whereOf(log[2]), log.join("\n"));
  // Same shape is not enough: the lock must bind the same ids too (#87). The
  // input has a duplicate and a non-UUID, so raw ids differ from the filtered
  // set. The UPDATE's SET params come first; its WHERE params start at the
  // first placeholder after " where ".
  assert.equal(params.length, 2, log.join("\n"));
  const firstWhereParam = (sqlText: string) =>
    Number(sqlText.slice(sqlText.indexOf(" where ")).match(/\$(\d+)/)?.[1]) - 1;
  const lockParams = params[0].slice(firstWhereParam(log[1]));
  const updateParams = params[1].slice(firstWhereParam(log[2]));
  assert.deepEqual(lockParams, ["rico", b.id, a.id]);
  assert.deepEqual(lockParams, updateParams);
});

test("another owner's transcription is an unknown id to them", async () => {
  const mine = await createTranscription(db, "rico", {
    client_transcription_id: "owned-1",
    text: "rico's",
  });
  const all = { mode: "delta" as const, since: "2000-01-01T00:00:00.000Z" };
  const ana = (await listTranscriptions(db, "ana", all)).transcriptions;
  assert.equal(
    ana.some((x) => x.id === mine.id),
    false,
  );
  assert.equal(
    (await listLiveTranscriptions(db, "ana")).some((x) => x.id === mine.id),
    false,
  );

  const unknown = "00000000-0000-4000-8000-000000000000";
  assert.deepEqual(
    await deleteTranscription(db, "ana", mine.id),
    await deleteTranscription(db, "ana", unknown),
  );
  assert.deepEqual(await deleteTranscription(db, "ana", mine.id), {
    ok: false,
    code: "not_found",
  });
  assert.deepEqual(await batchDeleteTranscriptions(db, "ana", [mine.id]), {
    deleted: [],
  });

  const still = (await listTranscriptions(db, "rico", all)).transcriptions.find(
    (x) => x.id === mine.id,
  );
  assert.deepEqual(still, mine, "rico's row is unchanged");
});

test("two owners may use the same client transcription id", async () => {
  const input = { client_transcription_id: "shared-client-id", text: "x" };
  const r = await createTranscription(db, "rico", input);
  const a = await createTranscription(db, "ana", input);
  assert.notEqual(a.id, r.id);
  assert.equal((await createTranscription(db, "ana", input)).id, a.id);
  assert.equal((await createTranscription(db, "rico", input)).id, r.id);
});
