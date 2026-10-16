import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker, UnrecoverableError } from 'bullmq';
import { Redis } from 'ioredis';
import { withValidatedInput } from '@axiapay/payments-runtime/shared/validation/input-validation';
import { PaymentRecoveryService } from '@axiapay/payments-runtime/modules/payments/services/payment-recovery.service';
import { PaymentRecoverySweepDto } from './payment-recovery-job.dto.js';

/** Own the BullMQ wake-up scheduler, bounded consumer and Redis lifecycle. PostgreSQL recovery rows survive lost queue jobs; this adapter invokes existing workflows and never supplies a payment outcome. */
@Injectable()
export class PaymentRecoveryWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(PaymentRecoveryWorker.name);
  private queue?: Queue;
  private worker?: Worker;
  private producerConnection?: Redis;
  private consumerConnection?: Redis;

  /** Read validated deployment settings and inject the application operation; disabled deployments construct no Redis clients. */
  constructor(
    @Inject(ConfigService) private readonly configuration: ConfigService,
    @Inject(PaymentRecoveryService)
    private readonly recovery: PaymentRecoveryService,
  ) {}

  /** One durable scheduler wakes bounded DB batches; global concurrency prevents worker replicas multiplying the configured recovery concurrency. */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.configuration.get<boolean>('PAYMENT_RECOVERY_ENABLED')) {
      return;
    }
    const url = this.configuration.getOrThrow<string>('REDIS_QUEUE_URL');
    this.producerConnection = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 5000,
      commandTimeout: 5000,
    });
    this.consumerConnection = new Redis(url, {
      maxRetriesPerRequest: null,
      connectTimeout: 5000,
    });
    this.producerConnection.on('error', () =>
      this.logger.error({ event: 'payment_recovery_queue_unavailable' }),
    );
    this.consumerConnection.on('error', () =>
      this.logger.error({ event: 'payment_recovery_consumer_unavailable' }),
    );
    this.queue = new Queue('payment-recovery', {
      connection: this.producerConnection,
    });
    this.queue.on('error', () =>
      this.logger.error({ event: 'payment_recovery_queue_unavailable' }),
    );
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.queue.waitUntilReady(),
        new Promise<never>((_resolve, reject) => {
          startupTimer = setTimeout(
            () => reject(new Error('Queue startup deadline exceeded.')),
            5000,
          );
        }),
      ]);
      await this.queue.setGlobalConcurrency(1);
      await this.queue.upsertJobScheduler(
        'check-payments',
        { every: 15_000 },
        {
          name: 'check-payments',
          data: { version: 1 },
          opts: {
            attempts: 5,
            backoff: { type: 'exponential', delay: 1000 },
            removeOnComplete: { count: 100 },
            removeOnFail: { count: 100 },
          },
        },
      );
      this.worker = new Worker(
        'payment-recovery',
        async (job) => {
          if (job.name !== 'check-payments') {
            throw new UnrecoverableError('Unsupported payment recovery job.');
          }
          await withValidatedInput(PaymentRecoverySweepDto, job.data, () =>
            this.recovery.recoverDueBatch(
              this.configuration.getOrThrow<number>(
                'PAYMENT_RECOVERY_CONCURRENCY',
              ),
            ),
          );
        },
        { connection: this.consumerConnection, concurrency: 1 },
      );
      this.worker.on('error', () =>
        this.logger.error({ event: 'payment_recovery_worker_unavailable' }),
      );
      this.worker.on('failed', () =>
        this.logger.error({ event: 'payment_recovery_batch_failed' }),
      );
    } catch {
      this.producerConnection.disconnect();
      this.consumerConnection.disconnect();
      await this.onModuleDestroy();
      throw new Error(
        'Payment recovery could not start. Check queue connectivity and configuration.',
      );
    } finally {
      clearTimeout(startupTimer);
    }
  }

  /** Drain in-flight recovery before queue connections and the application database pool are closed. Durable leases recover interrupted processes. */
  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    this.producerConnection?.disconnect();
    this.consumerConnection?.disconnect();
    this.worker = undefined;
    this.queue = undefined;
  }
}
