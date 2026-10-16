import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

/** Own one evictable-cache connection with bounded commands; outages never queue authentication reads or delay shutdown. */
@Injectable()
export class RedisCacheConnection implements OnModuleInit, OnModuleDestroy {
  readonly client: Redis;
  private readonly logger = new Logger(RedisCacheConnection.name);
  private unavailableUntilMs = 0;
  private hasReportedOutage = false;

  /** Borrow validated cache settings; durable queues use separate connections and policies. */
  constructor(@Inject(ConfigService) configuration: ConfigService) {
    this.client = new Redis(
      configuration.getOrThrow<string>('REDIS_CACHE_URL'),
      {
        lazyConnect: true,
        connectTimeout: 150,
        commandTimeout: 150,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 0,
        autoResendUnfulfilledCommands: false,
        retryStrategy: (attempt) => Math.min(attempt * 100, 2_000),
      },
    );
    this.client.on('error', () => this.reportFailure());
    this.client.on('ready', () => this.reportRecovery());
  }

  /** Connect in the background so Redis availability never gates application startup. */
  onModuleInit(): void {
    if (this.client.status !== 'wait') {
      return;
    }
    void this.client.connect().catch(() => this.reportFailure());
  }

  /** Admit commands only on a ready connection outside the brief outage cooldown. */
  get canUseCache(): boolean {
    return (
      this.client.status === 'ready' && Date.now() >= this.unavailableUntilMs
    );
  }

  /** Emit a controlled outage event without URLs, credentials, tokens, account details or raw Redis errors. */
  reportFailure(): void {
    this.unavailableUntilMs = Date.now() + 1_000;
    if (this.hasReportedOutage) {
      return;
    }
    this.hasReportedOutage = true;
    this.logger.warn({
      event: 'redis_cache_unavailable',
      fallback: 'postgresql',
    });
  }

  /** Restore normal cache use after the managed connection becomes healthy. */
  reportRecovery(): void {
    this.unavailableUntilMs = 0;
    this.hasReportedOutage = false;
  }

  /** Drop ephemeral pending cache work and reconnect timers without waiting for an unavailable server. */
  onModuleDestroy(): void {
    this.client.disconnect();
  }
}
