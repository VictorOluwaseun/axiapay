/** Construct PostgreSQL access for infrastructure callers; feature services use repository ports. */
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { DB } from './database.generated.js';

/** Persistence-only types generated from reviewed migrations; never exported through application ports. */
export type DatabaseSchema = DB;

/** Create a bounded pool. The owner must call destroy; constructing it does not issue a query. */
export function createDatabase(
  connectionString: string,
): Kysely<DatabaseSchema> {
  return new Kysely<DatabaseSchema>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString,
        max: 5,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 10_000,
      }),
    }),
  });
}
