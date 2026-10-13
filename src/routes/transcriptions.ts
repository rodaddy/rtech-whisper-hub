import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { fail, STATUS } from "../http/errors.ts";
import {
  batchCreateTranscriptions,
  batchDeleteTranscriptions,
  createTranscription,
  deleteTranscription,
  listTranscriptions,
} from "../sync/transcriptions.ts";
import { isUuid, MAX_LIMIT } from "../sync/common.ts";
import { type OwnerEnv, ownerOf } from "./owner.ts";

type Code = "invalid_request" | "not_found";

const MESSAGE: Record<Code, string> = {
  invalid_request: "invalid request",
  not_found: "transcription not found",
};

/** The shared envelope with this resource's default messages. */
const err = (c: Context, code: Code, message = MESSAGE[code]) =>
  fail(c, STATUS[code], code, message);

const Timestamp = z
  .string()
  .refine((v) => !Number.isNaN(new Date(v).getTime()), "invalid timestamp");

const TranscriptionInput = z.object({
  client_transcription_id: z.string().min(1),
  text: z.string(),
  raw_text: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  audio_duration_ms: z.number().int().nonnegative().nullable().optional(),
  status: z.string().min(1).optional(),
  created_at: Timestamp.optional(),
});
const BatchBody = z.object({ transcriptions: z.array(TranscriptionInput) });
/** Capped so one batch-delete statement stays bounded. */
const DeleteBody = z.object({ ids: z.array(z.string()).max(MAX_LIMIT) });
/** A cursor id: hub ids are UUIDs, and anything else would 500 in Postgres. */
const CursorId = z.string().refine(isUuid, "invalid id");
const DeleteOneBody = z.object({ id: z.string().min(1) });
/**
 * Limit defaults to 100 in the store and is capped at 500 by clampLimit.
 * since_id and before_id tie-break a cursor inside a run of equal stamps.
 */
const ListQuery = z
  .object({
    limit: z.coerce.number().int().positive().optional(),
    since: Timestamp.optional(),
    since_id: CursorId.optional(),
    before: Timestamp.optional(),
    before_id: CursorId.optional(),
  })
  .refine((q) => q.since_id === undefined || q.since !== undefined, {
    message: "since_id needs since",
  })
  .refine((q) => q.before_id === undefined || q.before !== undefined, {
    message: "before_id needs before",
  })
  .refine((q) => !(q.since && q.before), "since and before are exclusive");

/** Parse a JSON body against a schema; undefined when it is not JSON or does not match. */
async function body<T>(
  c: Context,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return undefined;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Transcription sync routes, paths relative to `/api`. Append-only: no
 * update route.
 */
export function transcriptionsRoutes(db: Db) {
  const app = new Hono<OwnerEnv>();

  app.get("/transcriptions/list", async (c) => {
    const ownerId = ownerOf(c);
    const q = ListQuery.safeParse(c.req.query());
    if (!q.success) return err(c, "invalid_request");
    const { limit, since, since_id, before, before_id } = q.data;
    const query =
      since !== undefined
        ? { mode: "delta" as const, since, sinceId: since_id, limit }
        : { mode: "snapshot" as const, before, beforeId: before_id, limit };
    return c.json(await listTranscriptions(db, ownerId, query), 200);
  });

  app.post("/transcriptions/batch-create", async (c) => {
    const ownerId = ownerOf(c);
    const b = await body(c, BatchBody);
    if (!b) return err(c, "invalid_request");
    const created = await batchCreateTranscriptions(
      db,
      ownerId,
      b.transcriptions,
    );
    return c.json({ created }, 200);
  });

  app.post("/transcriptions/create", async (c) => {
    const ownerId = ownerOf(c);
    const b = await body(c, TranscriptionInput);
    if (!b) return err(c, "invalid_request");
    return c.json(await createTranscription(db, ownerId, b), 200);
  });

  app.post("/transcriptions/batch-delete", async (c) => {
    const ownerId = ownerOf(c);
    const b = await body(c, DeleteBody);
    if (!b) return err(c, "invalid_request");
    return c.json(await batchDeleteTranscriptions(db, ownerId, b.ids), 200);
  });

  app.delete("/transcriptions/delete", async (c) => {
    const ownerId = ownerOf(c);
    const b = await body(c, DeleteOneBody);
    if (!b) return err(c, "invalid_request");
    const r = await deleteTranscription(db, ownerId, b.id);
    return r.ok ? c.json({}, 200) : err(c, "not_found");
  });

  return app;
}
