import { and, desc, eq, ilike, isNull, or } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { folders, notes } from "../db/schema.ts";
import {
  batch,
  clampLimit,
  type Failure,
  iso,
  isUuid,
  type ListQuery,
  listPlan,
  lockLive,
  ownedBy,
  notFound,
  type NotFound,
  ok,
  type Ok,
  type Result,
  softDelete,
  type Stamp,
  stamped,
  toDate,
} from "./common.ts";

type Row = typeof notes.$inferSelect;

/** The editable note fields, as they travel on the wire. */
export interface NoteFields {
  title?: string | null;
  content?: string;
  enhanced_content?: string | null;
  enhancement_prompt?: string | null;
  enhanced_at_content_hash?: string | null;
  note_type?: string;
  source_file?: string | null;
  audio_duration_seconds?: number | null;
  transcript?: string | null;
  participants?: string | null;
  calendar_event_id?: string | null;
  diarization_enabled?: number | null;
  expected_speaker_count?: number | null;
  folder_id?: string | null;
}

export interface NoteInput extends NoteFields {
  client_note_id: string;
  created_at?: string | Date;
}

export interface NoteUpdate extends NoteFields {
  id: string;
  base_updated_at?: string | Date;
}

export interface Note extends Required<NoteFields> {
  id: string;
  client_note_id: string;
  workspace_id: string | null;
  space_id: string | null;
  user_id: string;
  updated_by_user_id: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export type Conflict = Failure<"note_version_conflict", { note: Note }>;
export type UnknownFolder = Failure<"folder_not_found">;
const unknownFolder: UnknownFolder = { ok: false, code: "folder_not_found" };

export function toNote(r: Row): Note {
  return {
    id: r.id,
    client_note_id: r.clientNoteId,
    title: r.title,
    content: r.content,
    enhanced_content: r.enhancedContent,
    enhancement_prompt: r.enhancementPrompt,
    enhanced_at_content_hash: r.enhancedAtContentHash,
    note_type: r.noteType,
    source_file: r.sourceFile,
    audio_duration_seconds: r.audioDurationSeconds,
    transcript: r.transcript,
    participants: r.participants,
    calendar_event_id: r.calendarEventId,
    diarization_enabled: r.diarizationEnabled,
    expected_speaker_count: r.expectedSpeakerCount,
    folder_id: r.folderId,
    workspace_id: r.workspaceId,
    space_id: r.spaceId,
    user_id: r.ownerId,
    updated_by_user_id: r.ownerId,
    deleted_at: iso(r.deletedAt),
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt),
  };
}

/** Wire fields to columns; keys absent from the input stay absent. */
function columns(f: NoteFields) {
  const map = {
    title: f.title,
    content: f.content,
    enhancedContent: f.enhanced_content,
    enhancementPrompt: f.enhancement_prompt,
    enhancedAtContentHash: f.enhanced_at_content_hash,
    noteType: f.note_type,
    sourceFile: f.source_file,
    audioDurationSeconds: f.audio_duration_seconds,
    transcript: f.transcript,
    participants: f.participants,
    calendarEventId: f.calendar_event_id,
    diarizationEnabled: f.diarization_enabled,
    expectedSpeakerCount: f.expected_speaker_count,
    folderId: f.folder_id,
  };
  return Object.fromEntries(
    Object.entries(map).filter(([, v]) => v !== undefined),
  ) as Partial<typeof map>;
}

/**
 * A note may point at any folder of its owner the hub knows, tombstoned or not
 * (no cascade). Another owner's folder is unknown.
 */
async function folderKnown(
  db: Db,
  ownerId: string,
  id: string | null | undefined,
) {
  if (id === null || id === undefined) return true;
  if (!isUuid(id)) return false;
  const [row] = await db
    .select({ id: folders.id })
    .from(folders)
    .where(and(eq(folders.id, id), ownedBy(folders, ownerId)));
  return row !== undefined;
}

async function createOne(
  db: Db,
  ownerId: string,
  input: NoteInput,
  stamp: Stamp,
): Promise<Result<Note, UnknownFolder["code"]>> {
  // A retried create (same client id) returns the row the first try made.
  const [existing] = await db
    .select()
    .from(notes)
    .where(
      and(
        ownedBy(notes, ownerId),
        eq(notes.clientNoteId, input.client_note_id),
      ),
    );
  if (existing) return ok(toNote(existing));
  if (!(await folderKnown(db, ownerId, input.folder_id))) return unknownFolder;

  const now = stamp();
  const [row] = await db
    .insert(notes)
    .values({
      ...columns(input),
      ownerId,
      clientNoteId: input.client_note_id,
      createdAt:
        input.created_at === undefined ? now : toDate(input.created_at),
      updatedAt: now,
    })
    .returning();
  return ok(toNote(row));
}

export function createNote(db: Db, ownerId: string, input: NoteInput) {
  return stamped(db, (tx, stamp) => createOne(tx, ownerId, input, stamp));
}

/** All-or-nothing: the first failure rolls back the batch. Output is in input order. */
export function batchCreateNotes(db: Db, ownerId: string, inputs: NoteInput[]) {
  return batch(db, inputs, (tx, input, stamp) =>
    createOne(tx, ownerId, input, stamp),
  );
}

/**
 * Optimistic concurrency: with base_updated_at, a stored revision later than
 * the base is a conflict carrying the current row. Without it, last writer wins.
 */
export function updateNote(
  db: Db,
  ownerId: string,
  input: NoteUpdate,
): Promise<Ok<Note> | Conflict | NotFound | UnknownFolder> {
  return stamped(db, async (tx, stamp) => {
    const row = await lockLive(tx, notes, ownerId, input.id);
    if (!row) return notFound;
    if (
      input.base_updated_at !== undefined &&
      row.updatedAt.getTime() > toDate(input.base_updated_at).getTime()
    ) {
      return {
        ok: false,
        code: "note_version_conflict",
        note: toNote(row),
      } as const;
    }
    if (!(await folderKnown(tx, ownerId, input.folder_id)))
      return unknownFolder;
    const [updated] = await tx
      .update(notes)
      .set({ ...columns(input), updatedAt: stamp(row.updatedAt) })
      .where(and(eq(notes.id, row.id), ownedBy(notes, ownerId)))
      .returning();
    return ok(toNote(updated));
  });
}

export async function deleteNote(
  db: Db,
  ownerId: string,
  id: string,
): Promise<Result<Record<string, never>, NotFound["code"]>> {
  return (await softDelete(db, notes, ownerId, id)) ? ok({}) : notFound;
}

export const NOTES_PAGE = 50;

/** Snapshot or delta page, tombstones included. */
export async function listNotes(
  db: Db,
  ownerId: string,
  q: ListQuery,
): Promise<{ notes: Note[] }> {
  const { where, orderBy } = listPlan(notes, q);
  const rows = await db
    .select()
    .from(notes)
    .where(and(ownedBy(notes, ownerId), where))
    .orderBy(...orderBy)
    .limit(clampLimit(q.limit, NOTES_PAGE));
  return { notes: rows.map((r) => toNote(r)) };
}

/**
 * Live notes only, most recently changed first: the read view the MCP tools
 * serve (the desktop's getNotes order). Optional folder and note_type filters.
 */
export async function listLiveNotes(
  db: Db,
  ownerId: string,
  q: { limit?: number; folderId?: string; noteType?: string } = {},
): Promise<Note[]> {
  if (q.folderId !== undefined && !isUuid(q.folderId)) return [];
  const rows = await db
    .select()
    .from(notes)
    .where(
      and(
        ownedBy(notes, ownerId),
        isNull(notes.deletedAt),
        q.folderId === undefined ? undefined : eq(notes.folderId, q.folderId),
        q.noteType === undefined ? undefined : eq(notes.noteType, q.noteType),
      ),
    )
    .orderBy(desc(notes.updatedAt), desc(notes.id))
    .limit(clampLimit(q.limit));
  return rows.map((r) => toNote(r));
}

/** One live note by id, or undefined when unknown, malformed, or tombstoned. */
export async function getLiveNote(
  db: Db,
  ownerId: string,
  id: string,
): Promise<Note | undefined> {
  if (!isUuid(id)) return undefined;
  const [row] = await db
    .select()
    .from(notes)
    .where(
      and(eq(notes.id, id), ownedBy(notes, ownerId), isNull(notes.deletedAt)),
    );
  return row && toNote(row);
}

/** Escape LIKE wildcards so the query matches literally (backslash is the default escape). */
function likeLiteral(s: string) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Case-insensitive substring search over title, content, and transcript of
 * live notes, most recently changed first. ILIKE runs on Postgres and PGlite.
 */
export async function searchLiveNotes(
  db: Db,
  ownerId: string,
  query: string,
  limit?: number,
): Promise<Note[]> {
  const pattern = `%${likeLiteral(query)}%`;
  const rows = await db
    .select()
    .from(notes)
    .where(
      and(
        ownedBy(notes, ownerId),
        isNull(notes.deletedAt),
        or(
          ilike(notes.title, pattern),
          ilike(notes.content, pattern),
          ilike(notes.transcript, pattern),
        ),
      ),
    )
    .orderBy(desc(notes.updatedAt), desc(notes.id))
    .limit(clampLimit(limit));
  return rows.map((r) => toNote(r));
}
