import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import * as schema from '../model/schema.js';

/** Works for a root db handle AND a transaction handle, and for any pg driver (postgres-js, pglite). */
export type Database = PgDatabase<any, typeof schema>;
export type Executor = Database;

export function createDb(url: string) {
  // prepare:false keeps us compatible with Neon's pooled (pgbouncer) endpoints
  const client = postgres(url, { max: 10, prepare: false });
  const db = drizzle(client, { schema }) as unknown as Database;
  return { db, close: () => client.end() };
}
