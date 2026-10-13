// Remote MCP: the desktop rtw tools (ported from the desktop app,
// github.com/rodaddy/openwhispr, branch rtech-whisper: tools/rtw/src/mcp.ts)
// served over Streamable HTTP from the hub's own store, so an agent reaches notes
// without the Mac app running. Stateless: every POST gets a fresh server and
// transport. Tool names, inputs, and output text mirror rtw; ids are hub UUID
// strings where rtw has SQLite integers. Like rtw there is no delete tool, so an
// agent cannot destroy notes. Writes go through the same createNote/updateNote
// rules as the sync API: the hub stamps the times.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "./db/client.ts";
import { listLiveFolders } from "./sync/folders.ts";
import {
  createNote,
  getLiveNote,
  listLiveNotes,
  searchLiveNotes,
  updateNote,
} from "./sync/notes.ts";
import { listLiveTranscriptions } from "./sync/transcriptions.ts";

export const TOOL_NAMES = [
  "notes_list",
  "notes_search",
  "note_get",
  "note_create",
  "note_update",
  "folders_list",
  "transcriptions_list",
] as const;

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/** Same text framing as rtw: the payload as pretty-printed JSON. */
function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/** Same message shape rtw relays from the bridge: `CODE: message`. */
function fail(code: string, message: string): ToolResult {
  return {
    content: [{ type: "text", text: `${code}: ${message}` }],
    isError: true,
  };
}

export function createMcpServer(db: Db, ownerId: string): McpServer {
  const server = new McpServer({ name: "rtech-whisper-hub", version: "0.1.0" });

  server.registerTool(
    "notes_list",
    {
      description: "List notes on the hub, most recently changed first.",
      inputSchema: {
        limit: z.number().int().positive().optional(),
        folder_id: z.string().optional(),
        note_type: z.string().optional(),
      },
    },
    async ({ limit, folder_id, note_type }) =>
      ok(
        await listLiveNotes(db, ownerId, {
          limit: limit ?? 100,
          folderId: folder_id,
          noteType: note_type,
        }),
      ),
  );

  server.registerTool(
    "note_get",
    {
      description: "Fetch one note by id, with its full content.",
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) => {
      const note = await getLiveNote(db, ownerId, id);
      return note ? ok(note) : fail("NOT_FOUND", `Note ${id} not found`);
    },
  );

  server.registerTool(
    "notes_search",
    {
      description: "Search notes by text and return the matches.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().positive().optional(),
      },
    },
    async ({ query, limit }) =>
      ok(await searchLiveNotes(db, ownerId, query, limit)),
  );

  server.registerTool(
    "note_create",
    {
      description: "Create a note on the hub.",
      inputSchema: {
        title: z.string().min(1),
        content: z.string().optional(),
        note_type: z.string().optional(),
        folder_id: z.string().optional(),
        client_note_id: z.string().min(1).optional(),
      },
    },
    async ({ client_note_id, ...fields }) => {
      const r = await createNote(db, ownerId, {
        ...fields,
        client_note_id: client_note_id ?? randomUUID(),
      });
      return r.ok
        ? ok(r.value)
        : fail("NOT_FOUND", `Folder ${fields.folder_id} not found`);
    },
  );

  server.registerTool(
    "note_update",
    {
      description:
        "Update an existing note's title and/or content. Pass base_updated_at " +
        "(the updated_at you read) to refuse the write if the note changed since.",
      inputSchema: {
        id: z.string().min(1),
        title: z.string().optional(),
        content: z.string().optional(),
        base_updated_at: z.string().optional(),
      },
    },
    async ({ id, title, content, base_updated_at }) => {
      if (
        base_updated_at !== undefined &&
        Number.isNaN(Date.parse(base_updated_at))
      ) {
        return fail(
          "INVALID",
          `base_updated_at ${base_updated_at} is not a timestamp`,
        );
      }
      const r = await updateNote(db, ownerId, {
        id,
        title,
        content,
        base_updated_at,
      });
      if (r.ok) return ok(r.value);
      if (r.code === "note_version_conflict") {
        return fail(
          "CONFLICT",
          `Note ${id} changed since ${base_updated_at}; current updated_at ${r.note.updated_at}`,
        );
      }
      return fail("NOT_FOUND", `Note ${id} not found`);
    },
  );

  server.registerTool(
    "folders_list",
    { description: "List the hub's note folders.", inputSchema: {} },
    async () => ok(await listLiveFolders(db, ownerId)),
  );

  server.registerTool(
    "transcriptions_list",
    {
      description: "List recent dictation transcriptions.",
      inputSchema: { limit: z.number().int().positive().optional() },
    },
    async ({ limit }) => ok(await listLiveTranscriptions(db, ownerId, limit)),
  );

  return server;
}

/** Answer one MCP HTTP request statelessly: no session id, JSON responses. */
export async function handleMcp(
  db: Db,
  ownerId: string,
  req: Request,
): Promise<Response> {
  const server = createMcpServer(db, ownerId);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    await server.close();
  }
}
