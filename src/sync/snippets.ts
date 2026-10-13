import { and, eq, isNull, ne } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { snippets } from "../db/schema.ts";
import {
  batch,
  clampLimit,
  type DeltaQuery,
  type Failure,
  iso,
  type ListQuery,
  listPlan,
  lockLive,
  notFound,
  ownedBy,
  type NotFound,
  ok,
  type Result,
  paged,
  softDelete,
  type Stamp,
  stamped,
  toDate,
} from "./common.ts";

type Row = typeof snippets.$inferSelect;

export interface SnippetEntry {
  id: string;
  client_snippet_id: string;
  trigger: string;
  replacement: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SnippetInput {
  client_snippet_id: string;
  trigger: string;
  replacement: string;
  created_at?: string | Date;
  /** Accepted and ignored: the hub stamps updated_at itself. */
  updated_at?: string | Date;
}

export interface SnippetUpdate {
  id: string;
  trigger?: string;
  replacement?: string;
}

/** Snapshot pages by created_at descending with the cursor/cursor_id pair. */
export interface SnippetSnapshotQuery {
  mode: "snapshot";
  cursor?: string | Date;
  cursorId?: string;
  limit?: number;
}

export type TriggerTaken = Failure<"snippet_trigger_taken">;
const triggerTaken: TriggerTaken = { ok: false, code: "snippet_trigger_taken" };

export function toSnippet(r: Row): SnippetEntry {
  return {
    id: r.id,
    client_snippet_id: r.clientSnippetId,
    trigger: r.trigger,
    replacement: r.replacement,
    deleted_at: iso(r.deletedAt),
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt),
  };
}

async function triggerInUse(
  db: Db,
  ownerId: string,
  trigger: string,
  exceptId?: string,
) {
  const [row] = await db
    .select({ id: snippets.id })
    .from(snippets)
    .where(
      and(
        ownedBy(snippets, ownerId),
        eq(snippets.trigger, trigger),
        isNull(snippets.deletedAt),
        exceptId === undefined ? undefined : ne(snippets.id, exceptId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

async function createOne(
  db: Db,
  ownerId: string,
  input: SnippetInput,
  stamp: Stamp,
): Promise<Result<SnippetEntry, TriggerTaken["code"]>> {
  // A retried create (same client id) returns the row the first try made.
  const [existing] = await db
    .select()
    .from(snippets)
    .where(
      and(
        ownedBy(snippets, ownerId),
        eq(snippets.clientSnippetId, input.client_snippet_id),
      ),
    );
  if (existing) return ok(toSnippet(existing));
  if (await triggerInUse(db, ownerId, input.trigger)) return triggerTaken;
  const now = stamp();
  const [row] = await db
    .insert(snippets)
    .values({
      ownerId,
      clientSnippetId: input.client_snippet_id,
      trigger: input.trigger,
      replacement: input.replacement,
      createdAt:
        input.created_at === undefined ? now : toDate(input.created_at),
      updatedAt: now,
    })
    .returning();
  return ok(toSnippet(row));
}

/** All-or-nothing: the first failure rolls back the batch. Output is in input order. */
export function batchCreateSnippets(
  db: Db,
  ownerId: string,
  inputs: SnippetInput[],
) {
  return batch(db, inputs, (tx, input: SnippetInput, stamp) =>
    createOne(tx, ownerId, input, stamp),
  );
}

/** Last writer wins; a trigger another live snippet uses is refused. */
export function updateSnippet(
  db: Db,
  ownerId: string,
  input: SnippetUpdate,
): Promise<Result<SnippetEntry, TriggerTaken["code"] | NotFound["code"]>> {
  return stamped(db, async (tx, stamp) => {
    const row = await lockLive(tx, snippets, ownerId, input.id);
    if (!row) return notFound;
    if (
      input.trigger !== undefined &&
      (await triggerInUse(tx, ownerId, input.trigger, row.id))
    ) {
      return triggerTaken;
    }
    const [updated] = await tx
      .update(snippets)
      .set({
        trigger: input.trigger ?? row.trigger,
        replacement: input.replacement ?? row.replacement,
        updatedAt: stamp(row.updatedAt),
      })
      .where(and(ownedBy(snippets, ownerId), eq(snippets.id, row.id)))
      .returning();
    return ok(toSnippet(updated));
  });
}

export async function deleteSnippet(
  db: Db,
  ownerId: string,
  id: string,
): Promise<Result<Record<string, never>, NotFound["code"]>> {
  return (await softDelete(db, snippets, ownerId, id)) ? ok({}) : notFound;
}

/** Snapshot (cursor/cursor_id, created_at desc) or delta (since/since_id, updated_at asc). */
export function listSnippets(
  db: Db,
  ownerId: string,
  q: SnippetSnapshotQuery | DeltaQuery,
) {
  const plan: ListQuery =
    q.mode === "delta"
      ? q
      : { mode: "snapshot", before: q.cursor, beforeId: q.cursorId };
  const { where, orderBy } = listPlan(snippets, plan);
  return paged(
    clampLimit(q.limit),
    (n) =>
      db
        .select()
        .from(snippets)
        .where(and(ownedBy(snippets, ownerId), where))
        .orderBy(...orderBy)
        .limit(n),
    toSnippet,
  );
}
