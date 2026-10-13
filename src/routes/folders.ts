import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { fail, STATUS } from "../http/errors.ts";
import { type OwnerEnv, ownerOf } from "./owner.ts";
import {
  batchCreateFolders,
  createFolder,
  deleteFolder,
  listFolders,
  updateFolder,
} from "../sync/folders.ts";

type Code = "invalid_request" | "not_found" | "folder_name_taken";

const MESSAGE: Record<Code, string> = {
  invalid_request: "invalid request",
  not_found: "folder not found",
  folder_name_taken: "a live folder already has that name",
};

/** The shared envelope with this resource's default messages. */
const err = (c: Context, code: Code, message = MESSAGE[code]) =>
  fail(c, STATUS[code], code, message);

const Timestamp = z
  .string()
  .refine((v) => !Number.isNaN(new Date(v).getTime()), "invalid timestamp");

const FolderInput = z.object({
  client_folder_id: z.string().min(1),
  name: z.string().min(1),
  is_default: z.boolean().optional(),
  sort_order: z.number().int().optional(),
  created_at: Timestamp.optional(),
});
const BatchBody = z.object({ folders: z.array(FolderInput) });
const UpdateBody = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  sort_order: z.number().int().optional(),
});
const DeleteBody = z.object({ id: z.string().min(1) });
const ListQuery = z.object({ since: Timestamp.optional() });

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

/** Folder sync routes, paths relative to `/api`, scoped to the device owner. */
export function foldersRoutes(db: Db) {
  const app = new Hono<OwnerEnv>();

  app.get("/folders/list", async (c) => {
    const ownerId = ownerOf(c);
    const q = ListQuery.safeParse(c.req.query());
    if (!q.success)
      return err(c, "invalid_request", "since must be a timestamp");
    return c.json(await listFolders(db, ownerId, { since: q.data.since }), 200);
  });

  app.post("/folders/batch-create", async (c) => {
    const ownerId = ownerOf(c);
    const b = await body(c, BatchBody);
    if (!b) return err(c, "invalid_request");
    const r = await batchCreateFolders(db, ownerId, b.folders);
    return r.ok ? c.json({ created: r.value }, 200) : err(c, r.code);
  });

  app.post("/folders/create", async (c) => {
    const ownerId = ownerOf(c);
    const b = await body(c, FolderInput);
    if (!b) return err(c, "invalid_request");
    const r = await createFolder(db, ownerId, b);
    return r.ok ? c.json(r.value, 200) : err(c, r.code);
  });

  app.patch("/folders/update", async (c) => {
    const ownerId = ownerOf(c);
    const b = await body(c, UpdateBody);
    if (!b) return err(c, "invalid_request");
    const r = await updateFolder(db, ownerId, b);
    return r.ok ? c.json(r.value, 200) : err(c, r.code);
  });

  app.delete("/folders/delete", async (c) => {
    const ownerId = ownerOf(c);
    const b = await body(c, DeleteBody);
    if (!b) return err(c, "invalid_request");
    const r = await deleteFolder(db, ownerId, b.id);
    return r.ok ? c.json(r.value, 200) : err(c, r.code);
  });

  return app;
}
