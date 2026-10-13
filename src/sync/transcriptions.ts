import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { transcriptions } from "../db/schema.ts";
import {
  batch,
  clampLimit,
  iso,
  isUuid,
  type ListQuery,
  listPlan,
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

type Row = typeof transcriptions.$inferSelect;

export interface Transcription {
  id: string;
  client_transcription_id: string;
  text: string;
  raw_text: string | null;
  provider: string | null;
  model: string | null;
  audio_duration_ms: number | null;
  status: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TranscriptionInput {
  client_transcription_id: string;
  text: string;
  raw_text?: string | null;
  provider?: string | null;
  model?: string | null;
  audio_duration_ms?: number | null;
  status?: string;
  created_at?: string | Date;
}

export function toTranscription(r: Row): Transcription {
  return {
    id: r.id,
    client_transcription_id: r.clientTranscriptionId,
    text: r.text,
    raw_text: r.rawText,
    provider: r.provider,
    model: r.model,
    audio_duration_ms: r.audioDurationMs,
    status: r.status,
    deleted_at: iso(r.deletedAt),
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt),
  };
}

async function createOne(
  db: Db,
  ownerId: string,
  input: TranscriptionInput,
  stamp: Stamp,
): Promise<Ok<Transcription>> {
  // A retried create (same owner, same client id) returns the row the first
  // try made.
  const [existing] = await db
    .select()
    .from(transcriptions)
    .where(
      and(
        ownedBy(transcriptions, ownerId),
        eq(transcriptions.clientTranscriptionId, input.client_transcription_id),
      ),
    );
  if (existing) return ok(toTranscription(existing));
  const now = stamp();
  const [row] = await db
    .insert(transcriptions)
    .values({
      ownerId,
      clientTranscriptionId: input.client_transcription_id,
      text: input.text,
      rawText: input.raw_text ?? null,
      provider: input.provider ?? null,
      model: input.model ?? null,
      audioDurationMs: input.audio_duration_ms ?? null,
      status: input.status ?? "completed",
      createdAt:
        input.created_at === undefined ? now : toDate(input.created_at),
      updatedAt: now,
    })
    .returning();
  return ok(toTranscription(row));
}

export async function createTranscription(
  db: Db,
  ownerId: string,
  input: TranscriptionInput,
): Promise<Transcription> {
  return (
    await stamped(db, (tx, stamp) => createOne(tx, ownerId, input, stamp))
  ).value;
}

/** Output is in input order. */
export async function batchCreateTranscriptions(
  db: Db,
  ownerId: string,
  inputs: TranscriptionInput[],
): Promise<Transcription[]> {
  return (
    await batch<TranscriptionInput, Transcription, never>(
      db,
      inputs,
      (tx, input, stamp) => createOne(tx, ownerId, input, stamp),
    )
  ).value;
}

/**
 * Soft-delete every live row of this owner named; returns the ids that were
 * live. Another owner's ids are left untouched, like unknown ids.
 */
export async function batchDeleteTranscriptions(
  db: Db,
  ownerId: string,
  ids: string[],
): Promise<{ deleted: string[] }> {
  const wanted = [...new Set(ids.filter(isUuid))];
  if (wanted.length === 0) return { deleted: [] };
  // Each tombstone is stamped after that row's last stamp, as softDelete does,
  // so a client holding a (stamp, id) cursor on the row still sees the delete.
  // Both SET expressions read the pre-update row, so deleted_at and updated_at
  // get the same stamp.
  const live = and(
    ownedBy(transcriptions, ownerId),
    inArray(transcriptions.id, wanted),
    isNull(transcriptions.deletedAt),
  );
  return stamped(db, async (tx, next) => {
    // The earliest stamp any row can get; it counts against the stamp budget.
    const now = next().toISOString();
    const stamp = sql`greatest(${now}::timestamptz, ${transcriptions.updatedAt} + interval '1 millisecond')`;
    // Lock the rows in id order first: the UPDATE alone locks in plan order,
    // so two overlapping batch-deletes could deadlock (40P01).
    await tx
      .select({ id: transcriptions.id })
      .from(transcriptions)
      .where(live)
      .orderBy(transcriptions.id)
      .for("update");
    const rows = await tx
      .update(transcriptions)
      .set({ deletedAt: stamp, updatedAt: stamp })
      .where(live)
      .returning({ id: transcriptions.id });
    return { deleted: rows.map((r) => r.id) };
  });
}

/** Soft-delete one live row; not_found when the id is unknown or a tombstone. */
export async function deleteTranscription(
  db: Db,
  ownerId: string,
  id: string,
): Promise<Result<Record<string, never>, NotFound["code"]>> {
  return (await softDelete(db, transcriptions, ownerId, id))
    ? ok({})
    : notFound;
}

export const TRANSCRIPTIONS_PAGE = 100;

/** Snapshot or delta page, tombstones included. */
export async function listTranscriptions(
  db: Db,
  ownerId: string,
  q: ListQuery,
): Promise<{ transcriptions: Transcription[] }> {
  const { where, orderBy } = listPlan(transcriptions, q);
  const rows = await db
    .select()
    .from(transcriptions)
    .where(and(ownedBy(transcriptions, ownerId), where))
    .orderBy(...orderBy)
    .limit(clampLimit(q.limit, TRANSCRIPTIONS_PAGE));
  return { transcriptions: rows.map(toTranscription) };
}

/**
 * Live transcriptions, newest first, discarded ones left out (the desktop's
 * getTranscriptions view).
 */
export async function listLiveTranscriptions(
  db: Db,
  ownerId: string,
  limit?: number,
): Promise<Transcription[]> {
  const rows = await db
    .select()
    .from(transcriptions)
    .where(
      and(
        ownedBy(transcriptions, ownerId),
        isNull(transcriptions.deletedAt),
        ne(transcriptions.status, "discarded"),
      ),
    )
    .orderBy(desc(transcriptions.createdAt), desc(transcriptions.id))
    .limit(clampLimit(limit, 50));
  return rows.map(toTranscription);
}
