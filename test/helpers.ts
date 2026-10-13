import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { Hono } from "hono";
import { migrationsFolder, type Db } from "../src/db/client.ts";
import type { OwnerEnv } from "../src/routes/owner.ts";

/** Mount sync routes under /api as if a device of `ownerId` had authenticated. */
export function asOwner(ownerId: string, routes: Hono<OwnerEnv>): Hono {
  const app = new Hono<OwnerEnv>();
  app.use("*", async (c, next) => {
    c.set("device", { id: `device-${ownerId}`, name: ownerId, ownerId });
    await next();
  });
  return app.route("/api", routes) as unknown as Hono;
}

/** Fresh in-memory Postgres (PGlite) with the committed migrations applied. */
export async function testDb(): Promise<{ db: Db; client: PGlite }> {
  const client = new PGlite();
  const pg = drizzle(client);
  await migrate(pg, { migrationsFolder });
  return { db: pg, client };
}

/** Unwrap an ok sync result, failing the test with the code otherwise. */
export function must<T>(
  r: { ok: true; value: T } | { ok: false; code: string },
): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}`);
  return r.value;
}

/** Page until the source says there is no more, returning every id seen in order. */
export async function drain<R extends { id: string }>(
  page: (last: R | undefined) => Promise<{ rows: R[]; more: boolean }>,
): Promise<string[]> {
  const seen: string[] = [];
  let last: R | undefined;
  for (let guard = 0; guard < 1000; guard++) {
    const { rows, more } = await page(last);
    seen.push(...rows.map((r) => r.id));
    if (!more) return seen;
    last = rows.at(-1);
  }
  throw new Error("paging did not terminate");
}
