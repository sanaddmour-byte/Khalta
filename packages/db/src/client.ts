import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Either the root handle or a transaction: query helpers accept both. */
export type Executor = Db | Tx;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  close: () => Promise<void>;
}

export function createDb(
  connectionString: string,
  onPoolError: (err: Error) => void = (err) => console.error('pg pool error', err.message),
): DbHandle {
  const pool = new pg.Pool({ connectionString, max: 10 });
  // An idle client can be terminated by the server (restart, failover). Without a listener Node
  // would crash on the unhandled 'error' event; the pool discards the client and reconnects.
  pool.on('error', onPoolError);
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}
