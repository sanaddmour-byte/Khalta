import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from './client';

export const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

/** How many migrations the shipped folder contains (from drizzle's journal). */
export function expectedMigrations(folder: string = migrationsFolder): number {
  const j = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, 'utf8')) as {
    entries: unknown[];
  };
  return j.entries.length;
}

/** How many migrations the database has applied. */
export async function appliedMigrations(db: Db): Promise<number> {
  const r = await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
  return Number((r.rows[0] as { n: number }).n);
}

export async function runMigrations(connectionString: string): Promise<void> {
  const handle = createDb(connectionString);
  try {
    await migrate(handle.db, { migrationsFolder });
  } finally {
    await handle.close();
  }
}
