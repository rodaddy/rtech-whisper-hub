import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export const migrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);

/** Common drizzle handle shared by postgres-js (production) and pglite (tests). */
export type Db = PgDatabase<PgQueryResultHKT, Record<string, never>>;

export function connect(databaseUrl: string) {
  const client = postgres(databaseUrl);
  const db = drizzle(client);
  return { db, close: () => client.end() };
}

export async function runMigrations(
  db: ReturnType<typeof connect>["db"],
): Promise<void> {
  await migrate(db, { migrationsFolder });
}

export async function ping(db: Db): Promise<void> {
  await db.execute(sql`select 1`);
}
