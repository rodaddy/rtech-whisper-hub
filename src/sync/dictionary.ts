import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { dictionaryEntries } from "../db/schema.ts";
import {
  batch,
  clampLimit,
  type DeltaQuery,
  iso,
  listPlan,
  lockLive,
  notFound,
  ownedBy,
  type NotFound,
  ok,
  type Ok,
  type Result,
  paged,
  softDelete,
  type Stamp,
  stamped,
  toDate,
} from "./common.ts";

type Row = typeof dictionaryEntries.$inferSelect;

export interface DictionaryEntry {
  id: string;
  client_dict_id: string;
  word: string;
  source: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DictionaryInput {
  client_dict_id: string;
  word: string;
  source?: string;
  created_at?: string | Date;
  /** Accepted and ignored: the hub stamps updated_at itself. */
  updated_at?: string | Date;
}

export interface DictionaryUpdate {
  id: string;
  word?: string;
  source?: string;
}

export function toEntry(r: Row): DictionaryEntry {
  return {
    id: r.id,
    client_dict_id: r.clientDictId,
    word: r.word,
    source: r.source,
    deleted_at: iso(r.deletedAt),
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt),
  };
}

async function createOne(
  db: Db,
  ownerId: string,
  input: DictionaryInput,
  stamp: Stamp,
): Promise<Ok<DictionaryEntry>> {
  // A retried create (same client id) returns the row the first try made.
  const [existing] = await db
    .select()
    .from(dictionaryEntries)
    .where(
      and(
        ownedBy(dictionaryEntries, ownerId),
        eq(dictionaryEntries.clientDictId, input.client_dict_id),
      ),
    );
  if (existing) return ok(toEntry(existing));
  const now = stamp();
  const [row] = await db
    .insert(dictionaryEntries)
    .values({
      ownerId,
      clientDictId: input.client_dict_id,
      word: input.word,
      source: input.source ?? "manual",
      createdAt:
        input.created_at === undefined ? now : toDate(input.created_at),
      updatedAt: now,
    })
    .returning();
  return ok(toEntry(row));
}

/** Output is in input order. */
export function batchCreateDictionary(
  db: Db,
  ownerId: string,
  inputs: DictionaryInput[],
) {
  return batch<DictionaryInput, DictionaryEntry, never>(
    db,
    inputs,
    (tx, input, stamp) => createOne(tx, ownerId, input, stamp),
  );
}

/** Last writer wins. */
export function updateDictionaryEntry(
  db: Db,
  ownerId: string,
  input: DictionaryUpdate,
): Promise<Result<DictionaryEntry, NotFound["code"]>> {
  return stamped(db, async (tx, stamp) => {
    const row = await lockLive(tx, dictionaryEntries, ownerId, input.id);
    if (!row) return notFound;
    const [updated] = await tx
      .update(dictionaryEntries)
      .set({
        word: input.word ?? row.word,
        source: input.source ?? row.source,
        updatedAt: stamp(row.updatedAt),
      })
      .where(
        and(
          ownedBy(dictionaryEntries, ownerId),
          eq(dictionaryEntries.id, row.id),
        ),
      )
      .returning();
    return ok(toEntry(updated));
  });
}

export async function deleteDictionaryEntry(
  db: Db,
  ownerId: string,
  id: string,
): Promise<Result<Record<string, never>, NotFound["code"]>> {
  return (await softDelete(db, dictionaryEntries, ownerId, id))
    ? ok({})
    : notFound;
}

/** Delta only: ascending by (updated_at, id), tombstones included. */
export function listDictionary(
  db: Db,
  ownerId: string,
  q: Omit<DeltaQuery, "mode"> = {},
) {
  const { where, orderBy } = listPlan(dictionaryEntries, {
    mode: "delta",
    ...q,
  });
  return paged(
    clampLimit(q.limit),
    (n) =>
      db
        .select()
        .from(dictionaryEntries)
        .where(and(ownedBy(dictionaryEntries, ownerId), where))
        .orderBy(...orderBy)
        .limit(n),
    toEntry,
  );
}
