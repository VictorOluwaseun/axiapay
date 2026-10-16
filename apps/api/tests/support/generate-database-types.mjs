/** Regenerate storage types from migrations in a disposable PostgreSQL database, never development data. */
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect } from 'kysely';
import { Migrator, FileMigrationProvider } from 'kysely/migration';
import { Pool } from 'pg';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const container = await new PostgreSqlContainer('postgres:18-alpine').start();
const database = new Kysely({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: container.getConnectionUri() }),
  }),
});
try {
  const migrator = new Migrator({
    db: database,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: fileURLToPath(
        new URL('../../migrations/', import.meta.url),
      ),
    }),
  });
  const result = await migrator.migrateToLatest();
  if (result.error) {
    throw result.error;
  }
  const child = spawnSync(
    'pnpm',
    [
      'exec',
      'kysely-codegen',
      '--url',
      container.getConnectionUri(),
      '--exclude-pattern',
      'public.kysely_*',
      '--type-mapping',
      '{"xid8":"string"}',
      '--out-file',
      '../../packages/payments-runtime/src/infrastructure/database/database.generated.ts',
      ...process.argv.slice(2),
    ],
    {
      stdio: 'inherit',
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
    },
  );
  if (child.status !== 0) {
    throw new Error('Database type generation failed.');
  }
} finally {
  await database.destroy();
  await container.stop();
}
