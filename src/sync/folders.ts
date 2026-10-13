import { and, asc, eq, isNull, ne } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { folders } from "../db/schema.ts";
import {
  batch,
  type Failure,
  iso,
  listPlan,
  lockLive,
  notFound,
  ownedBy,
  type NotFound,
  ok,
  type Result,
  softDelete,
  type Stamp,
  stamped,
  toDate,
} from "./common.ts";

type Row = typeof folders.$inferSelect;

export interface Folder {
  id: string;
  client_folder_id: string;
  name: string;
  is_default: boolean;
  sort_order: number;
  workspace_id: string | null;
  space_id: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FolderInput {
  client_folder_id: string;
  name: string;
  is_default?: boolean;
  sort_order?: number;
  created_at?: string | Date;
}

export interface FolderUpdate {
  id: string;
  name?: string;
  sort_order?: number;
}

export type NameTaken = Failure<"folder_name_taken">;
const nameTaken: NameTaken = { ok: false, code: "folder_name_taken" };

export function toFolder(r: Row): Folder {
  return {
    id: r.id,
    client_folder_id: r.clientFolderId,
    name: r.name,
    is_default: r.isDefault,
    sort_order: r.sortOrder,
    workspace_id: r.workspaceId,
    space_id: r.spaceId,
    deleted_at: iso(r.deletedAt),
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt),
  };
}

async function liveByName(
  db: Db,
  ownerId: string,
  name: string,
  exceptId?: string,
) {
  const [row] = await db
    .select()
    .from(folders)
    .where(
      and(
        ownedBy(folders, ownerId),
        eq(folders.name, name),
        isNull(folders.deletedAt),
        exceptId === undefined ? undefined : ne(folders.id, exceptId),
      ),
    )
    .limit(1);
  return row;
}

async function createOne(
  db: Db,
  ownerId: string,
  input: FolderInput,
  stamp: Stamp,
): Promise<Result<Folder, NameTaken["code"]>> {
  // A retried create (same client id) returns the row the first try made.
  const [existing] = await db
    .select()
    .from(folders)
    .where(
      and(
        ownedBy(folders, ownerId),
        eq(folders.clientFolderId, input.client_folder_id),
      ),
    );
  if (existing) return ok(toFolder(existing));

  const clash = await liveByName(db, ownerId, input.name);
  if (clash) {
    // Default-folder adoption: the client takes over the existing default.
    if (input.is_default && clash.isDefault) return ok(toFolder(clash));
    return nameTaken;
  }
  const now = stamp();
  const [row] = await db
    .insert(folders)
    .values({
      ownerId,
      clientFolderId: input.client_folder_id,
      name: input.name,
      isDefault: input.is_default ?? false,
      sortOrder: input.sort_order ?? 0,
      createdAt:
        input.created_at === undefined ? now : toDate(input.created_at),
      updatedAt: now,
    })
    .returning();
  return ok(toFolder(row));
}

export function createFolder(db: Db, ownerId: string, input: FolderInput) {
  return stamped(db, (tx, stamp) => createOne(tx, ownerId, input, stamp));
}

/** All-or-nothing: the first failure rolls back the batch. Output is in input order. */
export function batchCreateFolders(
  db: Db,
  ownerId: string,
  inputs: FolderInput[],
) {
  return batch(db, inputs, (tx, input, stamp) =>
    createOne(tx, ownerId, input, stamp),
  );
}

export function updateFolder(
  db: Db,
  ownerId: string,
  input: FolderUpdate,
): Promise<Result<Folder, NameTaken["code"] | NotFound["code"]>> {
  return stamped(db, async (tx, stamp) => {
    const row = await lockLive(tx, folders, ownerId, input.id);
    if (!row) return notFound;
    if (
      input.name !== undefined &&
      (await liveByName(tx, ownerId, input.name, row.id))
    ) {
      return nameTaken;
    }
    const [updated] = await tx
      .update(folders)
      .set({
        name: input.name ?? row.name,
        sortOrder: input.sort_order ?? row.sortOrder,
        updatedAt: stamp(row.updatedAt),
      })
      .where(and(ownedBy(folders, ownerId), eq(folders.id, row.id)))
      .returning();
    return ok(toFolder(updated));
  });
}

export async function deleteFolder(
  db: Db,
  ownerId: string,
  id: string,
): Promise<Result<Record<string, never>, NotFound["code"]>> {
  return (await softDelete(db, folders, ownerId, id)) ? ok({}) : notFound;
}

/** Unpaginated, ascending by (updated_at, id), tombstones included. */
export async function listFolders(
  db: Db,
  ownerId: string,
  q: { since?: string | Date; sinceId?: string } = {},
): Promise<{ folders: Folder[] }> {
  const { where, orderBy } = listPlan(folders, { mode: "delta", ...q });
  const rows = await db
    .select()
    .from(folders)
    .where(and(ownedBy(folders, ownerId), where))
    .orderBy(...orderBy);
  return { folders: rows.map(toFolder) };
}

/** Live folders only, in display order (sort_order, then creation). */
export async function listLiveFolders(
  db: Db,
  ownerId: string,
): Promise<Folder[]> {
  const rows = await db
    .select()
    .from(folders)
    .where(and(ownedBy(folders, ownerId), isNull(folders.deletedAt)))
    .orderBy(asc(folders.sortOrder), asc(folders.createdAt), asc(folders.id));
  return rows.map(toFolder);
}
