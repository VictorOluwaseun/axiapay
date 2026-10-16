import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import { sql } from 'kysely';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../../src/infrastructure/database/create-database.js';

/** Apply the actual migration chain (or a named upgrade baseline) in a disposable container, then use a restricted role. */
export async function startWalletTestDatabase(migrationTarget?: string) {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:18-alpine',
  ).start();
  const administrator = createDatabase(container.getConnectionUri());
  try {
    const migrator = new Migrator({
      db: administrator,
      provider: new FileMigrationProvider({
        fs,
        path,
        migrationFolder: fileURLToPath(
          new URL('../../../../apps/api/migrations/', import.meta.url),
        ),
      }),
    });
    const result = migrationTarget
      ? await migrator.migrateTo(migrationTarget)
      : await migrator.migrateToLatest();
    if (result.error) {
      throw result.error;
    }
    await sql`
      create role wallet_runtime login password 'wallet-test-only';
      select grant_wallet_runtime_access('wallet_runtime');
    `.execute(administrator);
    const runtimeUrl = new URL(container.getConnectionUri());
    runtimeUrl.username = 'wallet_runtime';
    runtimeUrl.password = 'wallet-test-only';
    const database = createDatabase(runtimeUrl.toString());
    return {
      connectionString: runtimeUrl.toString(),
      migrator,
      administrator,
      database,
      /** Release pools before destroying only this test's disposable container. */
      async stop(): Promise<void> {
        await database.destroy();
        await administrator.destroy();
        await container.stop();
      },
    };
  } catch (error) {
    await administrator.destroy();
    await container.stop();
    throw error;
  }
}

/** Connections are separated so tests exercise ordinary runtime permissions, not a superuser shortcut. */
export type WalletTestDatabase = Awaited<
  ReturnType<typeof startWalletTestDatabase>
>;
