import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { fail, STATUS } from "../http/errors.ts";
import {
  batchCreateSnippets,
  deleteSnippet,
  listSnippets,
  updateSnippet,
} from "../sync/snippets.ts";
import { isUuid } from "../sync/common.ts";
import { type OwnerEnv, ownerOf } from "./owner.ts";

type Code = "invalid_request" | "not_found" | "snippet_trigger_taken";

const MESSAGE: Record<Code, string> = {
  invalid_request: "invalid request",
  not_found: "snippet not found",
  snippet_trigger_taken: "a live snippet already uses that trigger",
};

/** The shared envelope with this resource's default messages. */
const err = (c: Context, code: Code, message = MESSAGE[code]) =>
  fail(c, STATUS[code], code, message);

const Timestamp = z
  .string()
  .refine((v) => !Number.isNaN(new Date(v).getTime()), "invalid timestamp");

const SnippetInput = z.object({
  client_snippet_id: z.string().min(1),
  trigger: z.string().min(1),
  replacement: z.string(),
  created_at: Timestamp.optional(),
  updated_at: Timestamp.optional(),
});
const BatchBody = z.object({ entries: z.array(SnippetInput) });
const UpdateBody = z.object({
  id: z.string().min(1),
  trigger: z.string().min(1).optional(),
  replacement: z.string().optional(),
});
const DeleteBody = z.object({ id: z.string().min(1) });
/** A cursor id: hub ids are UUIDs, and anything else would 500 in Postgres. */
const CursorId = z.string().refine(isUuid, "invalid id");
/** Contract limit: default 200 (the store default is 100), clamped to 500 by the store. */
const DEFAULT_LIST_LIMIT = 200;
const ListQuery = z
  .object({
    cursor: Timestamp.optional(),
    cursor_id: CursorId.optional(),
    since: Timestamp.optional(),
    since_id: CursorId.optional(),
    limit: z.coerce.number().int().min(1).optional(),
  })
  .refine((q) => q.cursor_id === undefined || q.cursor !== undefined, {
    message: "cursor_id needs cursor",
  })
  .refine((q) => q.since_id === undefined || q.since !== undefined, {
    message: "since_id needs since",
  })
  .refine(
    (q) =>
      !(
        (q.cursor !== undefined || q.cursor_id !== undefined) &&
        (q.since !== undefined || q.since_id !== undefined)
      ),
    "snapshot and delta params cannot be mixed",
  );

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

/** Snippet sync routes, paths relative to `/api`, scoped to the device owner. */
export function snippetsRoutes(db: Db) {
  const app = new Hono<OwnerEnv>();

  app.get("/snippets/list", async (c) => {
    const ownerId = ownerOf(c);
    const q = ListQuery.safeParse(c.req.query());
    if (!q.success) return err(c, "invalid_request");
    const { cursor, cursor_id, since, since_id } = q.data;
    const limit = q.data.limit ?? DEFAULT_LIST_LIMIT;
    const delta = since !== undefined || since_id !== undefined;
    const page = await listSnippets(
      db,
      ownerId,
      delta
        ? { mode: "delta", since, sinceId: since_id, limit }
        : { mode: "snapshot", cursor, cursorId: cursor_id, limit },
    );
    return c.json(page, 200);
  });

  app.post("/snippets/batch-create", async (c) => {
    const ownerId = ownerOf(c);
    const b = await body(c, BatchBody);
    if (!b) return err(c, "invalid_request");
    const r = await batchCreateSnippets(db, ownerId, b.entries);
    return r.ok ? c.json({ created: r.value }, 200) : err(c, r.code);
  });

  app.patch("/snippets/update", async (c) => {
    const ownerId = ownerOf(c);
    const b = await body(c, UpdateBody);
    if (!b) return err(c, "invalid_request");
    const r = await updateSnippet(db, ownerId, b);
    return r.ok ? c.json(r.value, 200) : err(c, r.code);
  });

  app.delete("/snippets/delete", async (c) => {
    const ownerId = ownerOf(c);
    const b = await body(c, DeleteBody);
    if (!b) return err(c, "invalid_request");
    const r = await deleteSnippet(db, ownerId, b.id);
    return r.ok ? c.json(r.value, 200) : err(c, r.code);
  });

  return app;
}
