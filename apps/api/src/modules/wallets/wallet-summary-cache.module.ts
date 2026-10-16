import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { RedisCacheConnection } from '../../infrastructure/redis/redis-cache-connection.js';
import { WalletSummaryInvalidationConnection } from '../../infrastructure/database/wallet-summary-invalidation.connection.js';
import { RedisWalletSummaryCache } from './data-sources/redis-wallet-summary-cache.js';
import { PostgresWalletSummaryInvalidationRepository } from './repositories/postgres-wallet-summary-invalidation.repository.js';
import { WalletSummaryInvalidationInterceptor } from '../../infrastructure/redis/wallet-summary-invalidation.interceptor.js';
import type { WalletSummaryCache } from './repositories/contracts/wallet-summary-cache.js';
import { WALLET_SUMMARY } from './wallet-summary.tokens.js';

/** Own API Redis display-cache connections and durable invalidation recovery; export only the cache port for wallet composition. */
@Module({
  imports: [ConfigModule],
  providers: [
    RedisCacheConnection,
    WalletSummaryInvalidationConnection,
    {
      provide: WALLET_SUMMARY.cache,
      inject: [RedisCacheConnection, ConfigService],
      useFactory: (
        connection: RedisCacheConnection,
        configuration: ConfigService,
      ) =>
        new RedisWalletSummaryCache(
          connection,
          configuration.getOrThrow<string>('AUTH_CODE_SECRET'),
        ),
    },
    {
      provide: WALLET_SUMMARY.invalidations,
      inject: [WalletSummaryInvalidationConnection, WALLET_SUMMARY.cache],
      useFactory: (
        connection: WalletSummaryInvalidationConnection,
        cache: WalletSummaryCache,
      ) =>
        new PostgresWalletSummaryInvalidationRepository(
          connection.database,
          cache,
        ),
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: WalletSummaryInvalidationInterceptor,
    },
  ],
  exports: [WALLET_SUMMARY.cache],
})
export class WalletSummaryCacheModule {}
