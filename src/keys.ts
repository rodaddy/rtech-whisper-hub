import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, or } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { devices } from "./db/schema.ts";

const KEY_PATTERN = /^rtw_[A-Za-z0-9_-]{43}$/;
const PREFIX_LENGTH = 12;
const LAST_USED_INTERVAL_MS = 60_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const lastUsedWrites = new Map<string, number>();

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export interface MintedDevice {
  id: string;
  name: string;
  ownerId: string;
  prefix: string;
  key: string;
}

/** Create a device and return its plaintext key. The key is never stored; only its hash is. */
export async function mintDevice(
  db: Db,
  name: string,
  ownerId: string,
): Promise<MintedDevice> {
  const key = `rtw_${randomBytes(32).toString("base64url")}`;
  const prefix = key.slice(0, PREFIX_LENGTH);
  const [row] = await db
    .insert(devices)
    .values({ name, ownerId, keyPrefix: prefix, keyHash: hashKey(key) })
    .returning({
      id: devices.id,
      name: devices.name,
      ownerId: devices.ownerId,
    });
  return { id: row.id, name: row.name, ownerId: row.ownerId, prefix, key };
}

export async function listDevices(db: Db) {
  return db
    .select({
      id: devices.id,
      name: devices.name,
      ownerId: devices.ownerId,
      prefix: devices.keyPrefix,
      createdAt: devices.createdAt,
      lastUsedAt: devices.lastUsedAt,
      revokedAt: devices.revokedAt,
    })
    .from(devices)
    .orderBy(devices.createdAt);
}

/** Revoke an active device by id or key prefix. Returns true when a row changed. */
export async function revokeDevice(
  db: Db,
  idOrPrefix: string,
): Promise<boolean> {
  const match = UUID_PATTERN.test(idOrPrefix)
    ? or(eq(devices.id, idOrPrefix), eq(devices.keyPrefix, idOrPrefix))
    : eq(devices.keyPrefix, idOrPrefix);
  const rows = await db
    .update(devices)
    .set({ revokedAt: new Date() })
    .where(and(match, isNull(devices.revokedAt)))
    .returning({ id: devices.id, revokedAt: devices.revokedAt });
  return rows.length > 0;
}

/** Resolve a bearer key to its device, or null for unknown, malformed, or revoked keys. */
export async function authenticate(
  db: Db,
  key: string,
): Promise<{ id: string; name: string; ownerId: string } | null> {
  if (!KEY_PATTERN.test(key)) return null;
  const [row] = await db
    .select({
      id: devices.id,
      name: devices.name,
      ownerId: devices.ownerId,
      revokedAt: devices.revokedAt,
    })
    .from(devices)
    .where(eq(devices.keyHash, hashKey(key)))
    .limit(1);
  if (!row || row.revokedAt !== null) return null;

  const now = Date.now();
  const last = lastUsedWrites.get(row.id);
  if (last === undefined || now - last >= LAST_USED_INTERVAL_MS) {
    lastUsedWrites.set(row.id, now);
    await db
      .update(devices)
      .set({ lastUsedAt: new Date(now) })
      .where(eq(devices.id, row.id));
  }
  return { id: row.id, name: row.name, ownerId: row.ownerId };
}
