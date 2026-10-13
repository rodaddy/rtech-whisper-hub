import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import pino from "pino";
import { createApp } from "../src/app.ts";
import type { Db } from "../src/db/client.ts";
import { mintDevice } from "../src/keys.ts";
import { createNote, deleteNote } from "../src/sync/notes.ts";
import { must, testDb } from "./helpers.ts";

// Remote MCP end to end through createApp on PGlite: device auth in front,
// raw JSON-RPC over the stateless Streamable HTTP transport.

const ADMIN = "admin-token-for-mcp-0123456789abcdef";

let db: Db;
let client: PGlite;
let app: ReturnType<typeof createApp>;
let key: string;

type Json = any;
let nextId = 1;

async function rpc(
  method: string,
  params: unknown,
  token: string | null = key,
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const res = await app.request("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  return { status: res.status, json: (await res.json()) as Json };
}

const callTool = (name: string, args: Record<string, unknown> = {}) =>
  rpc("tools/call", { name, arguments: args });

before(async () => {
  ({ db, client } = await testDb());
  app = createApp({
    db,
    logger: pino({ level: "silent" }),
    adminToken: ADMIN,
    ownerId: "rico",
  });
  const res = await app.request("/admin/devices", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: "mcp" }),
  });
  assert.equal(res.status, 201);
  key = ((await res.json()) as Json).key;
});
after(async () => client.close());

test("POST /mcp without a key is 401", async () => {
  const r = await rpc("tools/list", {}, null);
  assert.equal(r.status, 401);
  assert.equal(r.json.code, "unauthorized");
});

test("initialize, then tools/list shows exactly the seven rtw tools, no delete", async () => {
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  assert.equal(init.status, 200);
  assert.equal(init.json.result.serverInfo.name, "rtech-whisper-hub");

  const list = await rpc("tools/list", {});
  assert.equal(list.status, 200);
  const names = list.json.result.tools.map((t: { name: string }) => t.name);
  assert.equal(names.length, 7);
  assert.deepEqual(names.sort(), [
    "folders_list",
    "note_create",
    "note_get",
    "note_update",
    "notes_list",
    "notes_search",
    "transcriptions_list",
  ]);
  assert.ok(!names.some((n: string) => /delete/i.test(n)));
});

test("notes_list returns a created note and leaves tombstones out", async () => {
  const live = must(
    await createNote(db, "rico", { client_note_id: "mcp-live", content: "hi" }),
  );
  const gone = must(
    await createNote(db, "rico", { client_note_id: "mcp-gone", content: "x" }),
  );
  must(await deleteNote(db, "rico", gone.id));

  const r = await callTool("notes_list");
  assert.equal(r.status, 200);
  assert.notEqual(r.json.result.isError, true);
  const notes = JSON.parse(r.json.result.content[0].text) as Json[];
  const ids = notes.map((n) => n.id);
  assert.ok(ids.includes(live.id));
  assert.ok(!ids.includes(gone.id));
  assert.equal(notes.find((n) => n.id === live.id).content, "hi");

  const got = await callTool("note_get", { id: live.id });
  assert.equal(JSON.parse(got.json.result.content[0].text).content, "hi");
});

test("note_get of an unknown id is an MCP error result, not a crash", async () => {
  for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
    const r = await callTool("note_get", { id });
    assert.equal(r.status, 200);
    assert.equal(r.json.error, undefined);
    assert.equal(r.json.result.isError, true);
    assert.match(
      r.json.result.content[0].text,
      /^NOT_FOUND: Note .* not found$/,
    );
  }
});

const payload = (r: { json: Json }) =>
  JSON.parse(r.json.result.content[0].text);

test("notes_search matches content and transcript, case-insensitively, live only", async () => {
  const byContent = must(
    await createNote(db, "rico", {
      client_note_id: "s-content",
      content: "Buy ZEBRA food",
    }),
  );
  const byTranscript = must(
    await createNote(db, "rico", {
      client_note_id: "s-transcript",
      content: "x",
      transcript: "the zebra spoke",
    }),
  );
  const gone = must(
    await createNote(db, "rico", {
      client_note_id: "s-gone",
      content: "zebra deleted",
    }),
  );
  must(await deleteNote(db, "rico", gone.id));
  must(
    await createNote(db, "rico", {
      client_note_id: "s-pct",
      content: "100% done",
    }),
  );

  const r = await callTool("notes_search", { query: "zebra" });
  assert.notEqual(r.json.result.isError, true);
  const ids = (payload(r) as Json[]).map((n) => n.id).sort();
  assert.deepEqual(ids, [byContent.id, byTranscript.id].sort());

  // A LIKE wildcard in the query is literal, not "match anything".
  const pct = payload(await callTool("notes_search", { query: "%" })) as Json[];
  assert.deepEqual(
    pct.map((n) => n.content),
    ["100% done"],
  );

  const one = payload(
    await callTool("notes_search", { query: "zebra", limit: 1 }),
  );
  assert.equal(one.length, 1);
});

test("note_create then note_get round-trips, with a generated client id", async () => {
  const c = await callTool("note_create", {
    title: "From MCP",
    content: "body",
  });
  assert.notEqual(c.json.result.isError, true);
  const made = payload(c);
  assert.equal(made.title, "From MCP");
  assert.match(made.client_note_id, /^[0-9a-f-]{36}$/);
  assert.ok(made.updated_at);

  const got = payload(await callTool("note_get", { id: made.id }));
  assert.equal(got.content, "body");
  assert.equal(got.title, "From MCP");
});

test("note_update applies a fresh base and refuses a stale one with CONFLICT", async () => {
  const made = payload(
    await callTool("note_create", { title: "v1", content: "a" }),
  );
  const u1 = await callTool("note_update", {
    id: made.id,
    content: "b",
    base_updated_at: made.updated_at,
  });
  assert.notEqual(u1.json.result.isError, true);
  const current = payload(u1);
  assert.equal(current.content, "b");

  const stale = await callTool("note_update", {
    id: made.id,
    content: "c",
    base_updated_at: made.updated_at,
  });
  assert.equal(stale.json.result.isError, true);
  const text = stale.json.result.content[0].text;
  assert.match(text, /^CONFLICT: /);
  assert.ok(text.includes(current.updated_at));
  assert.equal(
    payload(await callTool("note_get", { id: made.id })).content,
    "b",
  );
});

test("another owner's key cannot list or get rico's note", async () => {
  const mine = must(
    await createNote(db, "rico", {
      client_note_id: "mcp-owned",
      content: "mine",
    }),
  );
  const { key: anaKey } = await mintDevice(db, "ana-phone", "ana");

  const list = await rpc(
    "tools/call",
    { name: "notes_list", arguments: {} },
    anaKey,
  );
  assert.equal(list.status, 200);
  const ids = (JSON.parse(list.json.result.content[0].text) as Json[]).map(
    (n) => n.id,
  );
  assert.ok(!ids.includes(mine.id));

  const got = await rpc(
    "tools/call",
    { name: "note_get", arguments: { id: mine.id } },
    anaKey,
  );
  assert.equal(got.status, 200);
  assert.equal(got.json.result.isError, true);
  assert.match(
    got.json.result.content[0].text,
    /^NOT_FOUND: Note .* not found$/,
  );
});
