/** Exercise the compiled worker as a separate OS process against disposable PostgreSQL and durable queue Redis. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { Queue, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import { GenericContainer } from 'testcontainers';
import { describe, expect, it } from 'vitest';
import { startWalletTestDatabase } from '../../../../packages/backend/tests/support/wallet-test-database.js';

describe('standalone worker process', () => {
  it('runs a real recovery sweep using only worker configuration and drains on SIGTERM', async () => {
    const database = await startWalletTestDatabase();
    const container = await new GenericContainer('redis:8-alpine')
      .withCommand(['redis-server', '--maxmemory-policy', 'noeviction'])
      .withExposedPorts(6379)
      .start();
    const url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
    const connection = new Redis(url, { maxRetriesPerRequest: null });
    const queue = new Queue('payment-recovery', { connection });
    const events = new QueueEvents('payment-recovery', { connection });
    let child: ReturnType<typeof spawn> | undefined;
    let output = '';
    try {
      await sql`select grant_service_payments_runtime_access('wallet_runtime'); select grant_payment_recovery_runtime_access('wallet_runtime');`.execute(
        database.administrator,
      );
      await events.waitUntilReady();
      const completed = new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(
          () =>
            reject(
              new Error(`Worker did not complete a recovery sweep: ${output}`),
            ),
          20_000,
        );
        events.once('completed', () => {
          clearTimeout(deadline);
          resolve();
        });
      });
      // Deliberately omit API secrets, PORT, cache and funding settings from the child environment.
      child = spawn(
        process.execPath,
        [fileURLToPath(new URL('../../dist/main.js', import.meta.url))],
        {
          cwd: fileURLToPath(new URL('../..', import.meta.url)),
          env: {
            PATH: process.env.PATH,
            NODE_ENV: 'test',
            LOG_LEVEL: 'silent',
            DATABASE_URL: database.connectionString,
            REDIS_QUEUE_URL: url,
            PAYMENT_RECOVERY_ENABLED: 'true',
            PAYMENT_RECOVERY_CONCURRENCY: '2',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      await completed;
      expect(await queue.getGlobalConcurrency()).toBe(1);
      const exited = new Promise<NodeJS.Signals | null>((resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new Error('Worker did not drain after SIGTERM.')),
          5000,
        );
        child?.once('exit', (_code, signal) => {
          clearTimeout(deadline);
          resolve(signal);
        });
      });
      child.kill('SIGTERM');
      await expect(exited).resolves.toBe('SIGTERM');
      child = undefined;
    } finally {
      child?.kill('SIGKILL');
      await events.close();
      await queue.close();
      connection.disconnect();
      await container.stop();
      await database.stop();
    }
  });
});
