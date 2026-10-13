/** Construct PostgreSQL access for infrastructure callers; application use cases use repository ports. */
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

/** No application tables exist yet; replace with generated schema types after the first migration. */
export type DatabaseSchema = Record<never, never>;

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
