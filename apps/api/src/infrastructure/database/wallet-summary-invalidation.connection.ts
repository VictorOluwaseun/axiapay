import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DatabaseSchema } from '@axiapay/payments-runtime/infrastructure/database/create-database';
import { CacheInvalidationConnection } from './cache-invalidation.connection.js';

/** Isolate wallet summary recovery from business transactions and bound every database wait. */
@Injectable()
export class WalletSummaryInvalidationConnection extends CacheInvalidationConnection<DatabaseSchema> {
  /** Own one lifecycle-managed recovery connection using validated credentials. */
  constructor(@Inject(ConfigService) configuration: ConfigService) {
    super(configuration, 'wallet-summary-invalidation');
  }
}
