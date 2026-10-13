import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import type { Hono } from "hono";
import type { Db } from "../src/db/client.ts";
import { transcriptions } from "../src/db/schema.ts";
import { transcriptionsRoutes } from "../src/routes/transcriptions.ts";
import { asOwner, testDb } from "./helpers.ts";

let db: Db;
let client: PGlite;
let app: Hono;
before(async () => {
  ({ db, client } = await testDb());
  app = asOwner("rico", transcriptionsRoutes(db));
});
after(async () => client.close());

function send(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("batch-create then snapshot list returns newest first", async () => {
  const res = await send("POST", "/api/transcriptions/batch-create", {
    transcriptions: [
      {
        client_transcription_id: "t-1",
        text: "one",
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        client_transcription_id: "t-2",
        text: "two",
        provider: "whisper",
        audio_duration_ms: 1200,
        created_at: "2026-01-02T00:00:00.000Z",
      },
    ],
  });
  assert.equal(res.status, 200);
  const { created } = await res.json();
  assert.deepEqual(
    created.map((x: { text: string }) => x.text),
    ["one", "two"],
  );
  assert.equal(created[1].audio_duration_ms, 1200);
  assert.equal(created[0].status, "completed");

  const list = await app.request("/api/transcriptions/list?limit=2");
  assert.equal(list.status, 200);
  const { transcriptions } = await list.json();
  assert.deepEqual(
    transcriptions.map((x: { text: string }) => x.text),
    ["two", "one"],
  );
});

test("a create retried with the same client id returns the same row", async () => {
  const input = { client_transcription_id: "t-retry", text: "hello" };
  const a = await (
    await send("POST", "/api/transcriptions/create", input)
  ).json();
  const res = await send("POST", "/api/transcriptions/create", input);
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.id, a.id);
  assert.equal(b.created_at, a.created_at);
});

test("batch-delete returns only live ids and the delta carries tombstones", async () => {
  const start = new Date(Date.now() - 1).toISOString();
  const { created } = await (
    await send("POST", "/api/transcriptions/batch-create", {
      transcriptions: [
        { client_transcription_id: "t-d1", text: "d1" },
        { client_transcription_id: "t-d2", text: "d2" },
      ],
    })
  ).json();
  const ids = created.map((x: { id: string }) => x.id);

  const first = await send("POST", "/api/transcriptions/batch-delete", {
    ids: [ids[0]],
  });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { deleted: [ids[0]] });

  const second = await send("POST", "/api/transcriptions/batch-delete", {
    ids: [ids[0], ids[1], "00000000-0000-4000-8000-000000000000"],
  });
  assert.deepEqual(await second.json(), { deleted: [ids[1]] });

  const list = await app.request(
    `/api/transcriptions/list?since=${encodeURIComponent(start)}`,
  );
  assert.equal(list.status, 200);
  const { transcriptions } = await list.json();
  for (const id of ids) {
    const row = transcriptions.find((x: { id: string }) => x.id === id);
    assert.ok(row, "tombstone travels in delta");
    assert.ok(row.deleted_at);
  }
});

test("a bad body is 400 invalid_request", async () => {
  const missing = await send("POST", "/api/transcriptions/create", {
    text: "no id",
  });
  assert.equal(missing.status, 400);
  const err = await missing.json();
  assert.equal(err.code, "invalid_request");
  assert.equal(typeof err.error.message, "string");

  const notJson = await app.request("/api/transcriptions/batch-create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{nope",
  });
  assert.equal(notJson.status, 400);

  const badIds = await send("POST", "/api/transcriptions/batch-delete", {
    ids: "x",
  });
  assert.equal(badIds.status, 400);

  const tooMany = await send("POST", "/api/transcriptions/batch-delete", {
    ids: Array.from({ length: 501 }, () => crypto.randomUUID()),
  });
  assert.equal(tooMany.status, 400, "batch-delete caps ids at 500");
  const atCap = await send("POST", "/api/transcriptions/batch-delete", {
    ids: Array.from({ length: 500 }, () => crypto.randomUUID()),
  });
  assert.equal(atCap.status, 200);

  const badLimit = await app.request("/api/transcriptions/list?limit=abc");
  assert.equal(badLimit.status, 400);
});

/** Insert `n` rows that all share one updated_at (and one created_at). */
async function seedRun(prefix: string, n: number, stamp: Date) {
  await db.insert(transcriptions).values(
    Array.from({ length: n }, (_, i) => ({
      ownerId: "rico",
      clientTranscriptionId: `${prefix}-${i}`,
      text: `${prefix} ${i}`,
      createdAt: stamp,
      updatedAt: stamp,
    })),
  );
}

type Row = { id: string; updated_at: string; created_at: string };

async function listPage(params: Record<string, string>): Promise<Row[]> {
  const res = await app.request(
    `/api/transcriptions/list?${new URLSearchParams(params)}`,
  );
  assert.equal(res.status, 200);
  return (await res.json()).transcriptions;
}

test("delta pages a run of more than 100 equal updated_at with since_id, no skips or repeats", async () => {
  const stamp = new Date("2030-01-01T00:00:00.000Z");
  await seedRun("t-run-delta", 150, stamp);
  const seen: string[] = [];
  let since = new Date(stamp.getTime() - 1).toISOString();
  let sinceId: string | undefined;
  for (let guard = 0; guard < 10; guard++) {
    const params: Record<string, string> = { limit: "100", since };
    if (sinceId) params.since_id = sinceId;
    const page = await listPage(params);
    seen.push(...page.map((r) => r.id));
    if (page.length < 100) break;
    const last = page[page.length - 1];
    since = last.updated_at;
    sinceId = last.id;
  }
  assert.equal(seen.length, 150, "every row of the run, once");
  assert.equal(new Set(seen).size, 150, "no repeats");
  assert.deepEqual(seen, [...seen].sort(), "ascending by id inside the run");
});

test("snapshot pages a run of more than 100 equal created_at with before_id", async () => {
  const stamp = new Date("2001-01-01T00:00:00.000Z");
  await seedRun("t-run-snap", 120, stamp);
  const seen: string[] = [];
  let before = new Date(stamp.getTime() + 1).toISOString();
  let beforeId: string | undefined;
  for (let guard = 0; guard < 10; guard++) {
    const params: Record<string, string> = { limit: "100", before };
    if (beforeId) params.before_id = beforeId;
    const page = await listPage(params);
    seen.push(...page.map((r) => r.id));
    if (page.length < 100) break;
    const last = page[page.length - 1];
    before = last.created_at;
    beforeId = last.id;
  }
  assert.equal(seen.length, 120, "every row of the run, once");
  assert.equal(new Set(seen).size, 120, "no repeats");
});

test("since alone keeps its old strict behaviour", async () => {
  const stamp = new Date("2031-01-01T00:00:00.000Z");
  await seedRun("t-run-old", 3, stamp);
  const at = await listPage({ since: stamp.toISOString() });
  assert.equal(
    at.filter((r) => r.updated_at === stamp.toISOString()).length,
    0,
    "since is strict: rows at the cursor are not returned",
  );
  const justBefore = await listPage({
    since: new Date(stamp.getTime() - 1).toISOString(),
  });
  assert.equal(justBefore.length, 3);
  const ids = justBefore.map((r) => r.id);
  assert.deepEqual(ids, [...ids].sort(), "ascending by (updated_at, id)");
});

test("since_id without since, and since with before, are 400", async () => {
  const lone = await app.request(
    "/api/transcriptions/list?since_id=00000000-0000-4000-8000-000000000000",
  );
  assert.equal(lone.status, 400);
  const both = await app.request(
    "/api/transcriptions/list?since=2026-01-01T00:00:00.000Z&before=2026-01-01T00:00:00.000Z",
  );
  assert.equal(both.status, 400);
});

test("DELETE /transcriptions/delete tombstones one row, then 404", async () => {
  const start = new Date(Date.now() - 1).toISOString();
  const row = await (
    await send("POST", "/api/transcriptions/create", {
      client_transcription_id: "t-single-del",
      text: "bye",
    })
  ).json();

  const first = await send("DELETE", "/api/transcriptions/delete", {
    id: row.id,
  });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), {});

  const delta = await listPage({ since: start });
  const tomb = delta.find((x) => x.id === row.id) as
    (Row & { deleted_at: string | null }) | undefined;
  assert.ok(tomb, "tombstone travels in delta");
  assert.ok(tomb.deleted_at);
  assert.ok(tomb.updated_at > row.updated_at, "updated_at is bumped");

  const second = await send("DELETE", "/api/transcriptions/delete", {
    id: row.id,
  });
  assert.equal(second.status, 404);
  assert.equal((await second.json()).code, "not_found");

  const unknown = await send("DELETE", "/api/transcriptions/delete", {
    id: "not-a-uuid",
  });
  assert.equal(unknown.status, 404);

  const bad = await send("DELETE", "/api/transcriptions/delete", {});
  assert.equal(bad.status, 400);
});

test("a malformed since_id or before_id is 400 invalid_request, not 500", async () => {
  for (const q of [
    "since=2026-01-01T00:00:00.000Z&since_id=abc",
    "before=2026-01-01T00:00:00.000Z&before_id=abc",
  ]) {
    const res = await app.request(`/api/transcriptions/list?${q}`);
    assert.equal(res.status, 400, q);
    assert.equal((await res.json()).code, "invalid_request", q);
  }
});

test("another owner gets 404 deleting rico's row and does not list it", async () => {
  const row = await (
    await send("POST", "/api/transcriptions/create", {
      client_transcription_id: "t-owned",
      text: "rico's",
    })
  ).json();
  const ana = asOwner("ana", transcriptionsRoutes(db));

  const del = await ana.request("/api/transcriptions/delete", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: row.id }),
  });
  assert.equal(del.status, 404);
  assert.equal((await del.json()).code, "not_found");

  const list = await ana.request(
    "/api/transcriptions/list?since=2000-01-01T00:00:00.000Z&limit=500",
  );
  assert.equal(list.status, 200);
  const { transcriptions: seen } = await list.json();
  assert.equal(
    seen.some((x: { id: string }) => x.id === row.id),
    false,
  );

  const mine = await listPage({
    since: "2000-01-01T00:00:00.000Z",
    limit: "500",
  });
  const still = mine.find((x) => x.id === row.id) as
    (Row & { deleted_at: string | null }) | undefined;
  assert.ok(still);
  assert.equal(still.deleted_at, null);
});
