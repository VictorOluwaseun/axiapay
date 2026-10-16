/** Apply reviewed migration files explicitly; API startup never mutates the database schema. */
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '@axiapay/payments-runtime/infrastructure/database/create-database';

/** Run pending migrations and release the pool on success or failure; never undo changes implicitly. */
async function migrate(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to run migrations.');
  }
  const database = createDatabase(connectionString);
  const migrationFolder = fileURLToPath(
    new URL('../../../migrations/', import.meta.url),
  );
  const migrator = new Migrator({
    db: database,
    provider: new FileMigrationProvider({ fs, path, migrationFolder }),
  });
  try {
    const { error, results } = await migrator.migrateToLatest();
    for (const result of results ?? []) {
      console.info(`${result.migrationName}: ${result.status}`);
    }
    if (error) {
      throw error;
    }
  } finally {
    await database.destroy();
  }
}

await migrate();
