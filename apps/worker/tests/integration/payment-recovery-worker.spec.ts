/** Verify the actual BullMQ 6/ioredis worker, versioned input boundary, scheduler coalescing and restart after disposable queue data loss. */
import { ConfigService } from '@nestjs/config';
import { Queue, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import { GenericContainer } from 'testcontainers';
import { describe, expect, it, vi } from 'vitest';
import { PaymentRecoveryWorker } from '../../src/jobs/payment-recovery.worker.js';
import type { PaymentRecoveryService } from '@axiapay/backend/modules/payments/services/payment-recovery.service';
import { asyncSignal } from '../../../../packages/backend/tests/support/async-signal.js';
import { createServer } from 'node:net';

describe('payment recovery worker', () => {
  it('starts no connections when disabled', async () => {
    const recoverDueBatch = vi.fn();
    const worker = new PaymentRecoveryWorker(
      new ConfigService({ PAYMENT_RECOVERY_ENABLED: false }),
      { recoverDueBatch } as unknown as PaymentRecoveryService,
    );
    await worker.onApplicationBootstrap();
    await worker.onModuleDestroy();
    expect(recoverDueBatch).not.toHaveBeenCalled();
  });

  it('fails startup within a bounded deadline and releases clients when queue Redis is unavailable', async () => {
    const listener = createServer();
    await new Promise<void>((resolve) =>
      listener.listen(0, '127.0.0.1', resolve),
    );
    const address = listener.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a loopback TCP endpoint.');
    }
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    const recoverDueBatch = vi.fn();
    const worker = new PaymentRecoveryWorker(
      new ConfigService({
        PAYMENT_RECOVERY_ENABLED: true,
        REDIS_QUEUE_URL: `redis://127.0.0.1:${address.port}`,
        PAYMENT_RECOVERY_CONCURRENCY: 2,
      }),
      { recoverDueBatch } as unknown as PaymentRecoveryService,
    );
    await expect(worker.onApplicationBootstrap()).rejects.toThrow(
      'Payment recovery could not start.',
    );
    await worker.onModuleDestroy();
    expect(recoverDueBatch).not.toHaveBeenCalled();
  });

  it('runs bounded batches, rejects injected input and recreates the scheduler after Redis data loss', async () => {
    const container = await new GenericContainer('redis:8-alpine')
      .withCommand(['redis-server', '--maxmemory-policy', 'noeviction'])
      .withExposedPorts(6379)
      .start();
    const url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
    const configuration = new ConfigService({
      PAYMENT_RECOVERY_ENABLED: true,
      REDIS_QUEUE_URL: url,
      PAYMENT_RECOVERY_CONCURRENCY: 2,
    });
    const signal = asyncSignal();
    const recoverDueBatch = vi.fn(async () => signal.resolve());
    let worker = new PaymentRecoveryWorker(configuration, {
      recoverDueBatch,
    } as unknown as PaymentRecoveryService);
    const connection = new Redis(url, { maxRetriesPerRequest: null });
    const queue = new Queue('payment-recovery', { connection });
    const events = new QueueEvents('payment-recovery', { connection });
    try {
      await worker.onApplicationBootstrap();
      await signal.promise;
      expect(recoverDueBatch).toHaveBeenCalledWith(2);
      expect(await queue.getGlobalConcurrency()).toBe(1);
      const count = recoverDueBatch.mock.calls.length;
      const poisoned = await queue.add('check-payments', {
        version: 1,
        paymentId: 'injected-target',
      });
      await expect(poisoned.waitUntilFinished(events, 5000)).rejects.toThrow();
      expect(recoverDueBatch).toHaveBeenCalledTimes(count);
      await worker.onModuleDestroy();
      await events.close();
      await queue.close();
      await connection.flushdb();
      const restarted = asyncSignal();
      recoverDueBatch.mockImplementation(async () => restarted.resolve());
      worker = new PaymentRecoveryWorker(configuration, {
        recoverDueBatch,
      } as unknown as PaymentRecoveryService);
      await worker.onApplicationBootstrap();
      await restarted.promise;
      expect(recoverDueBatch).toHaveBeenCalledTimes(count + 1);
    } finally {
      await worker.onModuleDestroy();
      await events.close();
      await queue.close();
      connection.disconnect();
      await container.stop();
    }
  });
});
