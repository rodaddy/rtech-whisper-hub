import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { after, before, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import pino from "pino";
import { createApp } from "../src/app.ts";
import type { Db } from "../src/db/client.ts";
import { mintDevice } from "../src/keys.ts";
import { testDb } from "./helpers.ts";

// Acceptance test: a key sees and changes only its own owner's rows.

const ADMIN = "admin-token-for-tests-0123456789abcdef";
const quiet = pino(
  { level: "silent" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

let db: Db;
let client: PGlite;
let app: ReturnType<typeof createApp>;
let key1: string;
let key2: string;

async function call(key: string, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as any };
}

before(async () => {
  ({ db, client } = await testDb());
  app = createApp({ db, logger: quiet, adminToken: ADMIN, ownerId: "rico" });
  key1 = (await mintDevice(db, "rico-phone", "rico")).key;
  key2 = (await mintDevice(db, "ana-phone", "ana")).key;
});
after(async () => client.close());

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

test("owner 2 cannot list, pull, update or delete owner 1's rows", async () => {
  const note = await call(key1, "POST", "/api/notes/create", {
    client_note_id: "iso-note",
    content: "secret",
  });
  const folder = await call(key1, "POST", "/api/folders/create", {
    client_folder_id: "iso-folder",
    name: "Private",
  });
  const dict = await call(key1, "POST", "/api/dictionary/batch-create", {
    entries: [{ client_dict_id: "iso-dict", word: "Secret", source: "manual" }],
  });
  const snip = await call(key1, "POST", "/api/snippets/batch-create", {
    entries: [
      { client_snippet_id: "iso-snip", trigger: "sx", replacement: "secret" },
    ],
  });
  const tr = await call(key1, "POST", "/api/transcriptions/create", {
    client_transcription_id: "iso-tr",
    text: "secret",
  });
  const mine = [
    note.json.id,
    folder.json.id,
    dict.json.created[0].id,
    snip.json.created[0].id,
    tr.json.id,
  ];
  for (const id of mine) assert.ok(id, "owner 1 created every row");

  // List (snapshot) and delta pull.
  const since =
    "since=1970-01-01T00:00:00.000Z&since_id=00000000-0000-0000-0000-000000000000";
  for (const [path, field] of [
    ["/api/notes/list", "notes"],
    ["/api/folders/list", "folders"],
    ["/api/dictionary/list", "entries"],
    ["/api/snippets/list", "entries"],
    ["/api/transcriptions/list", "transcriptions"],
  ] as const) {
    for (const q of ["limit=500", `${since}&limit=500`]) {
      const theirs = await call(key2, "GET", `${path}?${q}`);
      assert.equal(theirs.status, 200, `${path}?${q}`);
      const rows = (theirs.json[field] ?? []) as { id: string }[];
      for (const id of mine) assert.ok(!ids(rows).includes(id), `${path}?${q}`);
    }
  }

  // Read, update and delete by id.
  const upd = await call(key2, "PATCH", "/api/notes/update", {
    id: note.json.id,
    content: "owned",
  });
  assert.equal(upd.status, 404);
  const fupd = await call(key2, "PATCH", "/api/folders/update", {
    id: folder.json.id,
    name: "owned",
  });
  assert.equal(fupd.status, 404);
  const dupd = await call(key2, "PATCH", "/api/dictionary/update", {
    id: dict.json.created[0].id,
    word: "owned",
    source: "manual",
  });
  assert.equal(dupd.status, 404);
  const supd = await call(key2, "PATCH", "/api/snippets/update", {
    id: snip.json.created[0].id,
    trigger: "owned",
    replacement: "owned",
  });
  assert.equal(supd.status, 404);
  for (const [path, id] of [
    ["/api/notes/delete", note.json.id],
    ["/api/folders/delete", folder.json.id],
    ["/api/dictionary/delete", dict.json.created[0].id],
    ["/api/snippets/delete", snip.json.created[0].id],
    ["/api/transcriptions/delete", tr.json.id],
  ]) {
    const d = await call(key2, "DELETE", path, { id });
    assert.equal(d.status, 404, path);
  }

  // Owner 1 still sees every row, live.
  for (const [path, field, id] of [
    ["/api/notes/list", "notes", note.json.id],
    ["/api/folders/list", "folders", folder.json.id],
    ["/api/dictionary/list", "entries", dict.json.created[0].id],
    ["/api/snippets/list", "entries", snip.json.created[0].id],
    ["/api/transcriptions/list", "transcriptions", tr.json.id],
  ] as const) {
    const own = await call(key1, "GET", `${path}?limit=500`);
    assert.equal(own.status, 200, path);
    const rows = (own.json[field] ?? []) as {
      id: string;
      deleted_at?: string | null;
    }[];
    const row = rows.find((r) => r.id === id);
    assert.ok(row, path);
    assert.ok(!row.deleted_at, path);
  }
});
