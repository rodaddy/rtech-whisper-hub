import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { type OwnerEnv, ownerOf } from "./owner.ts";
import { fail, STATUS } from "../http/errors.ts";
import { isUuid, type ListQuery } from "../sync/common.ts";
import {
  batchCreateNotes,
  createNote,
  deleteNote,
  listNotes,
  NOTES_PAGE,
  updateNote,
} from "../sync/notes.ts";

/** Notes list pages are capped lower than the store's generic ceiling. */
const NOTES_MAX_LIMIT = 200;

const invalid = (c: Context, message: string) =>
  fail(c, STATUS.invalid_request, "invalid_request", message);

/** Map a store failure code to its HTTP status and envelope. */
function storeFailure(c: Context, f: { code: string; note?: unknown }) {
  switch (f.code) {
    case "not_found":
      return fail(c, STATUS.not_found, "not_found", "note not found");
    case "note_version_conflict":
      return fail(
        c,
        STATUS.note_version_conflict,
        "note_version_conflict",
        "note changed on the hub",
        { note: f.note },
      );
    case "folder_not_found":
      return fail(
        c,
        STATUS.folder_not_found,
        "folder_not_found",
        "folder not found",
      );
    default:
      throw new Error(`unmapped store failure: ${f.code}`);
  }
}

const Timestamp = z
  .string()
  .refine((v) => !Number.isNaN(new Date(v).getTime()), "invalid timestamp");

const Fields = z.object({
  title: z.string().nullable().optional(),
  content: z.string().optional(),
  enhanced_content: z.string().nullable().optional(),
  enhancement_prompt: z.string().nullable().optional(),
  enhanced_at_content_hash: z.string().nullable().optional(),
  note_type: z.string().min(1).optional(),
  source_file: z.string().nullable().optional(),
  audio_duration_seconds: z.number().finite().nullable().optional(),
  transcript: z.string().nullable().optional(),
  participants: z.string().nullable().optional(),
  calendar_event_id: z.string().nullable().optional(),
  diarization_enabled: z.number().int().nullable().optional(),
  expected_speaker_count: z.number().int().nullable().optional(),
  folder_id: z.string().nullable().optional(),
});

const NoteInput = Fields.extend({
  client_note_id: z.string().min(1),
  created_at: Timestamp.optional(),
});

const BatchBody = z.object({ notes: z.array(NoteInput) });

const UpdateBody = Fields.extend({
  id: z.string().min(1),
  base_updated_at: Timestamp.optional(),
});

const DeleteBody = z.object({ id: z.string().min(1) });

/** A cursor id: hub ids are UUIDs, and anything else would 500 in Postgres. */
const CursorId = z.string().refine(isUuid, "invalid id");

const ListParams = z
  .object({
    limit: z.coerce.number().int().min(1).optional(),
    before: Timestamp.optional(),
    before_id: CursorId.optional(),
    since: Timestamp.optional(),
    since_id: CursorId.optional(),
  })
  .refine((q) => q.before_id === undefined || q.before !== undefined, {
    message: "before_id needs before",
  })
  .refine((q) => q.since_id === undefined || q.since !== undefined, {
    message: "since_id needs since",
  })
  .refine(
    (q) =>
      (q.before === undefined && q.before_id === undefined) ||
      (q.since === undefined && q.since_id === undefined),
    { message: "snapshot (before) and delta (since) params are exclusive" },
  );

/** Read and validate a JSON body; a Response return is the 400 already built. */
async function body<S extends z.ZodType>(
  c: Context,
  schema: S,
): Promise<z.infer<S> | Response> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return invalid(c, "body must be JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return invalid(c, z.prettifyError(parsed.error));
  return parsed.data;
}

/** Note sync routes, paths relative to /api. */
export function notesRoutes(db: Db) {
  const app = new Hono<OwnerEnv>();

  app.get("/notes/list", async (c) => {
    const ownerId = ownerOf(c);
    const parsed = ListParams.safeParse(c.req.query());
    if (!parsed.success) return invalid(c, z.prettifyError(parsed.error));
    const p = parsed.data;
    const limit = Math.min(p.limit ?? NOTES_PAGE, NOTES_MAX_LIMIT);
    const q: ListQuery =
      p.since !== undefined
        ? { mode: "delta", since: p.since, sinceId: p.since_id, limit }
        : { mode: "snapshot", before: p.before, beforeId: p.before_id, limit };
    return c.json(await listNotes(db, ownerId, q), 200);
  });

  app.post("/notes/batch-create", async (c) => {
    const ownerId = ownerOf(c);
    const b = await body(c, BatchBody);
    if (b instanceof Response) return b;
    const r = await batchCreateNotes(db, ownerId, b.notes);
    if (!r.ok) return storeFailure(c, r);
    const created = r.value.map((n) => ({
      client_note_id: n.client_note_id,
      id: n.id,
      updated_at: n.updated_at,
    }));
    return c.json({ created }, 200);
  });

  app.post("/notes/create", async (c) => {
    const ownerId = ownerOf(c);
    const b = await body(c, NoteInput);
    if (b instanceof Response) return b;
    const r = await createNote(db, ownerId, b);
    return r.ok ? c.json(r.value, 200) : storeFailure(c, r);
  });

  app.patch("/notes/update", async (c) => {
    const ownerId = ownerOf(c);
    const b = await body(c, UpdateBody);
    if (b instanceof Response) return b;
    const r = await updateNote(db, ownerId, b);
    return r.ok ? c.json(r.value, 200) : storeFailure(c, r);
  });

  app.delete("/notes/delete", async (c) => {
    const ownerId = ownerOf(c);
    const b = await body(c, DeleteBody);
    if (b instanceof Response) return b;
    const r = await deleteNote(db, ownerId, b.id);
    return r.ok ? c.json({}, 200) : storeFailure(c, r);
  });

  return app;
}
