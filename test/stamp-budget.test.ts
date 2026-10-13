import assert from "node:assert/strict";
import { after, before, type TestContext, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import pino from "pino";
import { createApp } from "../src/app.ts";
import type { Db } from "../src/db/client.ts";
import {
  dictionaryEntries,
  folders,
  notes,
  snippets,
  transcriptions,
} from "../src/db/schema.ts";
import { mintDevice } from "../src/keys.ts";
import {
  COMMIT_HEADROOM_MS,
  STAMP_BUDGET_MS,
  StampBudgetExceeded,
  stampClock,
} from "../src/sync/common.ts";
import {
  batchCreateDictionary,
  deleteDictionaryEntry,
  updateDictionaryEntry,
} from "../src/sync/dictionary.ts";
import {
  batchCreateFolders,
  createFolder,
  deleteFolder,
  updateFolder,
} from "../src/sync/folders.ts";
import {
  batchCreateNotes,
  createNote,
  deleteNote,
  updateNote,
} from "../src/sync/notes.ts";
import {
  batchCreateSnippets,
  deleteSnippet,
  updateSnippet,
} from "../src/sync/snippets.ts";
import {
  batchCreateTranscriptions,
  batchDeleteTranscriptions,
  createTranscription,
  deleteTranscription,
} from "../src/sync/transcriptions.ts";
import { must, testDb } from "./helpers.ts";

let db: Db;
let client: PGlite;
before(async () => ({ db, client } = await testDb()));
after(async () => client.close());

/**
 * Inject the clock: the first reading (the write's first stamp) is `base`,
 * every later one (later stamps, the pre-commit check) is `base + commitMs`.
 * `base` is a day ahead so an update's stamp is the clock, not prev + 1 ms.
 */
function commitAfter(t: TestContext, commitMs: number) {
  const base = Date.now() + 86_400_000;
  let readings = 0;
  t.mock.method(stampClock, "now", () =>
    readings++ === 0 ? base : base + commitMs,
  );
}

async function everyRow() {
  return {
    folders: await db.select().from(folders).orderBy(folders.id),
    notes: await db.select().from(notes).orderBy(notes.id),
    dictionary: await db
      .select()
      .from(dictionaryEntries)
      .orderBy(dictionaryEntries.id),
    snippets: await db.select().from(snippets).orderBy(snippets.id),
    transcriptions: await db
      .select()
      .from(transcriptions)
      .orderBy(transcriptions.id),
  };
}

let n = 0;
const fresh = (p: string) => `${p}-${++n}`;

/** Every hub write that stamps a row; `arrange` runs on the real clock. */
const writes: {
  name: string;
  arrange?: () => Promise<string>;
  act: (id: string) => Promise<unknown>;
}[] = [
  {
    name: "createNote",
    act: () =>
      createNote(db, "rico", { client_note_id: fresh("n"), content: "x" }),
  },
  {
    name: "batchCreateNotes",
    act: () =>
      batchCreateNotes(db, "rico", [
        { client_note_id: fresh("n"), content: "a" },
        { client_note_id: fresh("n"), content: "b" },
      ]),
  },
  {
    name: "updateNote",
    arrange: async () =>
      must(
        await createNote(db, "rico", {
          client_note_id: fresh("n"),
          content: "x",
        }),
      ).id,
    act: (id) => updateNote(db, "rico", { id, content: "y" }),
  },
  {
    name: "deleteNote",
    arrange: async () =>
      must(
        await createNote(db, "rico", {
          client_note_id: fresh("n"),
          content: "x",
        }),
      ).id,
    act: (id) => deleteNote(db, "rico", id),
  },
  {
    name: "createFolder",
    act: () =>
      createFolder(db, "rico", {
        client_folder_id: fresh("f"),
        name: fresh("F"),
      }),
  },
  {
    name: "batchCreateFolders",
    act: () =>
      batchCreateFolders(db, "rico", [
        { client_folder_id: fresh("f"), name: fresh("F") },
        { client_folder_id: fresh("f"), name: fresh("F") },
      ]),
  },
  {
    name: "updateFolder",
    arrange: async () =>
      must(
        await createFolder(db, "rico", {
          client_folder_id: fresh("f"),
          name: fresh("F"),
        }),
      ).id,
    act: (id) => updateFolder(db, "rico", { id, sort_order: 7 }),
  },
  {
    name: "deleteFolder",
    arrange: async () =>
      must(
        await createFolder(db, "rico", {
          client_folder_id: fresh("f"),
          name: fresh("F"),
        }),
      ).id,
    act: (id) => deleteFolder(db, "rico", id),
  },
  {
    name: "batchCreateDictionary",
    act: () =>
      batchCreateDictionary(db, "rico", [
        { client_dict_id: fresh("d"), word: fresh("w") },
      ]),
  },
  {
    name: "updateDictionaryEntry",
    arrange: async () =>
      must(
        await batchCreateDictionary(db, "rico", [
          { client_dict_id: fresh("d"), word: "w" },
        ]),
      )[0].id,
    act: (id) => updateDictionaryEntry(db, "rico", { id, word: "v" }),
  },
  {
    name: "deleteDictionaryEntry",
    arrange: async () =>
      must(
        await batchCreateDictionary(db, "rico", [
          { client_dict_id: fresh("d"), word: "w" },
        ]),
      )[0].id,
    act: (id) => deleteDictionaryEntry(db, "rico", id),
  },
  {
    name: "batchCreateSnippets",
    act: () =>
      batchCreateSnippets(db, "rico", [
        {
          client_snippet_id: fresh("s"),
          trigger: fresh("t"),
          replacement: "r",
        },
      ]),
  },
  {
    name: "updateSnippet",
    arrange: async () =>
      must(
        await batchCreateSnippets(db, "rico", [
          {
            client_snippet_id: fresh("s"),
            trigger: fresh("t"),
            replacement: "r",
          },
        ]),
      )[0].id,
    act: (id) => updateSnippet(db, "rico", { id, replacement: "q" }),
  },
  {
    name: "deleteSnippet",
    arrange: async () =>
      must(
        await batchCreateSnippets(db, "rico", [
          {
            client_snippet_id: fresh("s"),
            trigger: fresh("t"),
            replacement: "r",
          },
        ]),
      )[0].id,
    act: (id) => deleteSnippet(db, "rico", id),
  },
  {
    name: "createTranscription",
    act: () =>
      createTranscription(db, "rico", {
        client_transcription_id: fresh("t"),
        text: "x",
      }),
  },
  {
    name: "batchCreateTranscriptions",
    act: () =>
      batchCreateTranscriptions(db, "rico", [
        { client_transcription_id: fresh("t"), text: "a" },
        { client_transcription_id: fresh("t"), text: "b" },
      ]),
  },
  {
    name: "batchDeleteTranscriptions",
    arrange: async () =>
      (
        await createTranscription(db, "rico", {
          client_transcription_id: fresh("t"),
          text: "x",
        })
      ).id,
    act: (id) => batchDeleteTranscriptions(db, "rico", [id]),
  },
  {
    name: "deleteTranscription",
    arrange: async () =>
      (
        await createTranscription(db, "rico", {
          client_transcription_id: fresh("t"),
          text: "x",
        })
      ).id,
    act: (id) => deleteTranscription(db, "rico", id),
  },
];

for (const w of writes) {
  test(`${w.name}: a commit ${STAMP_BUDGET_MS} ms after the first stamp rolls back`, async (t) => {
    const id = w.arrange ? await w.arrange() : "";
    const rows = await everyRow();
    commitAfter(t, STAMP_BUDGET_MS);
    await assert.rejects(w.act(id), StampBudgetExceeded);
    t.mock.restoreAll();
    assert.deepEqual(await everyRow(), rows, "no row written or changed");
  });
}

test("a commit inside the budget writes the row", async (t) => {
  const rows = await everyRow();
  commitAfter(t, STAMP_BUDGET_MS - 1);
  const [a, b] = await batchCreateTranscriptions(db, "rico", [
    { client_transcription_id: fresh("t"), text: "a" },
    { client_transcription_id: fresh("t"), text: "b" },
  ]);
  t.mock.restoreAll();
  const after = await everyRow();
  assert.equal(after.transcriptions.length, rows.transcriptions.length + 2);
  assert.equal(
    Date.parse(b.updated_at) - Date.parse(a.updated_at),
    STAMP_BUDGET_MS - 1,
  );
});

test("over HTTP a write past the budget is a retryable 503 and writes nothing", async (t) => {
  const app = createApp({
    db,
    logger: pino({ level: "silent" }),
    adminToken: "t".repeat(40),
    ownerId: "rico",
  });
  const { key } = await mintDevice(db, "phone", "rico");
  const rows = await everyRow();
  commitAfter(t, STAMP_BUDGET_MS);
  const res = await app.request("/api/transcriptions/batch-create", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      transcriptions: [
        { client_transcription_id: fresh("t"), text: "a" },
        { client_transcription_id: fresh("t"), text: "b" },
      ],
    }),
  });
  t.mock.restoreAll();
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.code, "stamp_budget_exceeded");
  assert.equal(typeof body.error.message, "string");
  assert.deepEqual(await everyRow(), rows, "no row written");
});

test("the pre-commit check leaves COMMIT 10 s of the 30 s visibility bound", async (t) => {
  // The check runs before COMMIT is sent and COMMIT's latency is unbounded,
  // so a write already 20 s past its first stamp must not start its COMMIT:
  // a slow COMMIT would push the row past 30 s (docs/protocol.md section 8).
  const rows = await everyRow();
  commitAfter(t, 20_000);
  await assert.rejects(
    batchCreateTranscriptions(db, "rico", [
      { client_transcription_id: fresh("t"), text: "a" },
    ]),
    StampBudgetExceeded,
  );
  t.mock.restoreAll();
  assert.deepEqual(await everyRow(), rows, "no row written");
  assert.equal(STAMP_BUDGET_MS + COMMIT_HEADROOM_MS, 30_000);
});
