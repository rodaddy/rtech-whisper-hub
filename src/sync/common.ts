import { and, asc, desc, eq, gt, isNull, lt, or, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Db } from "../db/client.ts";

/** Wire timestamp: ISO 8601 UTC with milliseconds and Z. */
export function iso(d: Date): string;
export function iso(d: Date | null): string | null;
export function iso(d: Date | null): string | null {
  return d === null ? null : d.toISOString();
}

/** Parse a wire timestamp. Throws RangeError on anything Date cannot read. */
export function toDate(v: string | Date): Date {
  const d = v instanceof Date ? new Date(v.getTime()) : new Date(v);
  if (Number.isNaN(d.getTime()))
    throw new RangeError(`invalid timestamp: ${v}`);
  return d;
}

/**
 * The clock every stamp and the stamp-budget check read. A seam for tests
 * (`t.mock.method(stampClock, "now", ...)`): the database driver reads
 * Date.now too, so mocking Date.now cannot move only the stamp clock.
 */
export const stampClock = { now: (): number => Date.now() };

/**
 * The hub stamp for a change to a row last stamped at `prev`: now, but always
 * strictly after `prev`, so two writes in one millisecond still order and a
 * note's base_updated_at always sees the second one. Only `stamped` calls it,
 * so every stamp counts against the stamp budget.
 */
function nextStamp(prev?: Date): Date {
  const now = stampClock.now();
  return new Date(prev && prev.getTime() >= now ? prev.getTime() + 1 : now);
}

/**
 * Longest a write may run from its earliest stamp to the pre-commit check
 * (docs/protocol.md section 8, Cursors). A stamp is taken before the commit,
 * so a delta pass can read the table in between and move its cursor past the
 * stamp. The check runs before COMMIT is sent and nothing bounds how long
 * COMMIT itself takes, so the check leaves COMMIT_HEADROOM_MS of the 30 s
 * visibility bound for it; clients look back L = 60 s, which leaves the other
 * 30 s of L for clock skew.
 */
export const STAMP_BUDGET_MS = 20_000;

/** Time left for COMMIT: STAMP_BUDGET_MS + this is the 30 s visibility bound. */
export const COMMIT_HEADROOM_MS = 10_000;

/** A write ran past STAMP_BUDGET_MS; its transaction rolled back. Answered 503. */
export class StampBudgetExceeded extends Error {
  constructor(elapsedMs: number) {
    super(
      `write took ${elapsedMs} ms from its first stamp to the pre-commit check (budget ${STAMP_BUDGET_MS} ms)`,
    );
    this.name = "StampBudgetExceeded";
  }
}

/** Stamps a row inside `stamped`: nextStamp, recorded against the budget. */
export type Stamp = (prev?: Date) => Date;

/**
 * Run a write that stamps rows in one transaction. Immediately before COMMIT
 * is sent, a write whose earliest stamp is STAMP_BUDGET_MS or more in the past
 * throws StampBudgetExceeded, so the transaction rolls back and no row with a
 * stale stamp becomes visible. COMMIT's own latency is not checked; it has
 * COMMIT_HEADROOM_MS before a row misses the 30 s visibility bound.
 */
export function stamped<T>(
  db: Db,
  work: (tx: Db, stamp: Stamp) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    let earliest = Infinity;
    const out = await work(tx, (prev) => {
      const s = nextStamp(prev);
      earliest = Math.min(earliest, s.getTime());
      return s;
    });
    const elapsed = stampClock.now() - earliest;
    if (elapsed >= STAMP_BUDGET_MS) throw new StampBudgetExceeded(elapsed);
    return out;
  });
}

export type Failure<C extends string, X = object> = { ok: false; code: C } & X;
export type Ok<T> = { ok: true; value: T };
export type Result<T, C extends string, X = object> = Ok<T> | Failure<C, X>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });

export type NotFound = Failure<"not_found">;
export const notFound: NotFound = { ok: false, code: "not_found" };

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;

export function clampLimit(
  limit: number | undefined,
  fallback = DEFAULT_LIMIT,
) {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

/**
 * Delta: ascending by (updated_at, id), strictly after the cursor. With no
 * since_id the cursor is the timestamp alone and the comparison is strict.
 */
export interface DeltaQuery {
  mode: "delta";
  since?: string | Date;
  sinceId?: string;
  limit?: number;
}

/**
 * Snapshot: descending by (created_at, id), strictly before the cursor. With
 * no before_id the cursor is the timestamp alone and the comparison is strict.
 */
export interface SnapshotQuery {
  mode: "snapshot";
  before?: string | Date;
  beforeId?: string;
  limit?: number;
}

export type ListQuery = DeltaQuery | SnapshotQuery;

interface Keyed {
  id: PgColumn;
  createdAt: PgColumn;
  updatedAt: PgColumn;
}

/** WHERE and ORDER BY for a list query over a sync table. */
export function listPlan(
  t: Keyed,
  q: ListQuery,
): { where: SQL | undefined; orderBy: SQL[] } {
  if (q.mode === "delta") {
    let where: SQL | undefined;
    if (q.since !== undefined) {
      const since = toDate(q.since);
      where =
        q.sinceId === undefined
          ? gt(t.updatedAt, since)
          : or(
              gt(t.updatedAt, since),
              and(eq(t.updatedAt, since), gt(t.id, q.sinceId)),
            );
    }
    return { where, orderBy: [asc(t.updatedAt), asc(t.id)] };
  }
  let where: SQL | undefined;
  if (q.before !== undefined) {
    const before = toDate(q.before);
    where =
      q.beforeId === undefined
        ? lt(t.createdAt, before)
        : or(
            lt(t.createdAt, before),
            and(eq(t.createdAt, before), lt(t.id, q.beforeId)),
          );
  }
  return { where, orderBy: [desc(t.createdAt), desc(t.id)] };
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Hub ids are UUIDs; anything else can never name a row. */
export const isUuid = (v: string) => UUID_PATTERN.test(v);

interface SyncTable extends Keyed {
  deletedAt: PgColumn;
  ownerId: PgColumn;
}

/** Restrict a query to rows belonging to `ownerId`. */
export function ownedBy(t: { ownerId: PgColumn }, ownerId: string): SQL {
  return eq(t.ownerId, ownerId);
}

/**
 * Soft-delete a live row: set deleted_at and bump updated_at. Returns the new
 * stamp, or null when the id is unknown or already a tombstone.
 */
export async function softDelete(
  db: Db,
  t: PgTable & SyncTable,
  ownerId: string,
  id: string,
): Promise<Date | null> {
  if (!isUuid(id)) return null;
  return stamped(db, async (tx, next) => {
    const [row] = await tx
      .select({ updatedAt: t.updatedAt })
      .from(t)
      .where(and(eq(t.id, id), eq(t.ownerId, ownerId), isNull(t.deletedAt)))
      .for("update");
    if (!row) return null;
    const stamp = next(row.updatedAt as Date);
    await tx
      .update(t)
      .set({ deletedAt: stamp, updatedAt: stamp } as never)
      .where(and(eq(t.id, id), eq(t.ownerId, ownerId)));
    return stamp;
  });
}

/** Lock and return a live row by id, or undefined when unknown or tombstoned. */
export async function lockLive<T extends PgTable & SyncTable>(
  db: Db,
  t: T,
  ownerId: string,
  id: string,
): Promise<T["$inferSelect"] | undefined> {
  if (!isUuid(id)) return undefined;
  const [row] = await db
    .select()
    .from(t as PgTable)
    .where(and(eq(t.id, id), eq(t.ownerId, ownerId), isNull(t.deletedAt)))
    .for("update");
  return row as T["$inferSelect"] | undefined;
}

class BatchAbort extends Error {
  failure: Failure<string>;
  constructor(failure: Failure<string>) {
    super(failure.code);
    this.failure = failure;
  }
}

/**
 * Run `one` for each input in a single stamped transaction, in input order.
 * The first failure rolls the whole batch back and is returned as the batch's
 * result.
 */
export async function batch<I, T, F extends Failure<string>>(
  db: Db,
  inputs: I[],
  one: (tx: Db, input: I, stamp: Stamp) => Promise<Ok<T> | F>,
): Promise<Ok<T[]> | F> {
  try {
    return ok(
      await stamped(db, async (tx, stamp) => {
        const out: T[] = [];
        for (const input of inputs) {
          const r = await one(tx, input, stamp);
          if (!r.ok) throw new BatchAbort(r);
          out.push(r.value);
        }
        return out;
      }),
    );
  } catch (err) {
    if (err instanceof BatchAbort) return err.failure as F;
    throw err;
  }
}

/** Fetch one row past the limit to learn whether another page exists. */
export async function paged<R, E>(
  limit: number,
  fetch: (n: number) => Promise<R[]>,
  map: (r: R) => E,
): Promise<{ entries: E[]; hasMore: boolean }> {
  const rows = await fetch(limit + 1);
  return {
    entries: rows.slice(0, limit).map(map),
    hasMore: rows.length > limit,
  };
}
