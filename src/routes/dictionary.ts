import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { fail, STATUS } from "../http/errors.ts";
import {
  batchCreateDictionary,
  deleteDictionaryEntry,
  listDictionary,
  updateDictionaryEntry,
} from "../sync/dictionary.ts";
import { isUuid } from "../sync/common.ts";
import { ownerOf, type OwnerEnv } from "./owner.ts";

type Code = "invalid_request" | "not_found";

const MESSAGE: Record<Code, string> = {
  invalid_request: "invalid request",
  not_found: "dictionary entry not found",
};

/** Contract default page size; the store caps it at 500. */
const DEFAULT_LIMIT = 200;

/** The shared envelope with this resource's default messages. */
const err = (c: Context, code: Code, message = MESSAGE[code]) =>
  fail(c, STATUS[code], code, message);

const Timestamp = z
  .string()
  .refine((v) => !Number.isNaN(new Date(v).getTime()), "invalid timestamp");

const Source = z.enum(["manual", "learned"]);

const EntryInput = z.object({
  client_dict_id: z.string().min(1),
  word: z.string().min(1),
  source: Source,
  created_at: Timestamp.optional(),
  updated_at: Timestamp.optional(),
});
const BatchBody = z.object({ entries: z.array(EntryInput) });
const UpdateBody = z.object({
  id: z.string().min(1),
  word: z.string().min(1).optional(),
  source: Source.optional(),
});
const DeleteBody = z.object({ id: z.string().min(1) });
/** A cursor id: hub ids are UUIDs, and anything else would 500 in Postgres. */
const CursorId = z.string().refine(isUuid, "invalid id");
const ListQuery = z
  .object({
    since: Timestamp.optional(),
    since_id: CursorId.optional(),
    limit: z.coerce.number().int().min(1).optional(),
  })
  .refine((q) => q.since_id === undefined || q.since !== undefined, {
    message: "since_id needs since",
  });

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

/** Dictionary sync routes, paths relative to `/api`, scoped to the device's owner. */
export function dictionaryRoutes(db: Db) {
  const app = new Hono<OwnerEnv>();

  app.get("/dictionary/list", async (c) => {
    const ownerId = ownerOf(c);
    const q = ListQuery.safeParse(c.req.query());
    if (!q.success) return err(c, "invalid_request");
    return c.json(
      await listDictionary(db, ownerId, {
        since: q.data.since,
        sinceId: q.data.since_id,
        limit: q.data.limit ?? DEFAULT_LIMIT,
      }),
      200,
    );
  });

  app.post("/dictionary/batch-create", async (c) => {
    const ownerId = ownerOf(c);
    const b = await body(c, BatchBody);
    if (!b) return err(c, "invalid_request");
    const r = await batchCreateDictionary(db, ownerId, b.entries);
    return c.json({ created: r.value }, 200);
  });

  app.patch("/dictionary/update", async (c) => {
    const ownerId = ownerOf(c);
    const b = await body(c, UpdateBody);
    if (!b) return err(c, "invalid_request");
    const r = await updateDictionaryEntry(db, ownerId, b);
    return r.ok ? c.json(r.value, 200) : err(c, r.code);
  });

  app.delete("/dictionary/delete", async (c) => {
    const ownerId = ownerOf(c);
    const b = await body(c, DeleteBody);
    if (!b) return err(c, "invalid_request");
    const r = await deleteDictionaryEntry(db, ownerId, b.id);
    return r.ok ? c.json(r.value, 200) : err(c, r.code);
  });

  return app;
}
