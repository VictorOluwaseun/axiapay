/** Verify installed data clients against disposable PostgreSQL and Redis instances. */
import { describe, expect, it } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer } from 'testcontainers';
import { Redis } from 'ioredis';
import { sql } from 'kysely';
import { createDatabase } from '../../src/infrastructure/database/create-database.js';

describe('data client compatibility', () => {
  it('rolls back PostgreSQL writes when an operation fails', async () => {
    const container = await new PostgreSqlContainer(
      'postgres:18-alpine',
    ).start();
    const database = createDatabase(container.getConnectionUri());
    try {
      await sql`create table setup_probe (id integer primary key)`.execute(
        database,
      );
      await expect(
        database.transaction().execute(async (transaction) => {
          await sql`insert into setup_probe (id) values (1)`.execute(
            transaction,
          );
          throw new Error('simulated operation failure');
        }),
      ).rejects.toThrow('simulated operation failure');
      const result = await sql<{
        count: string;
      }>`select count(*)::text as count from setup_probe`.execute(database);
      expect(result.rows[0]?.count).toBe('0');
    } finally {
      await database.destroy();
      await container.stop();
    }
  });
  it('supports cache population, expiry metadata, and explicit invalidation', async () => {
    const container = await new GenericContainer('redis:8-alpine')
      .withExposedPorts(6379)
      .start();
    const cache = new Redis({
      host: container.getHost(),
      port: container.getMappedPort(6379),
      maxRetriesPerRequest: 1,
    });
    try {
      await cache.set('setup:scope:query', 'cached-result', 'EX', 60);
      expect(await cache.get('setup:scope:query')).toBe('cached-result');
      expect(await cache.ttl('setup:scope:query')).toBeGreaterThan(0);
      await cache.del('setup:scope:query');
      expect(await cache.get('setup:scope:query')).toBeNull();
    } finally {
      cache.disconnect();
      await container.stop();
    }
  });
});
