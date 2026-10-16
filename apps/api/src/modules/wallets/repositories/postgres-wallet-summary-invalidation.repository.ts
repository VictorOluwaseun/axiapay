import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '@axiapay/payments-runtime/infrastructure/database/create-database';
import { PostgresCacheInvalidationDelivery } from '../../../infrastructure/database/postgres-cache-invalidation-delivery.js';
import type { WalletSummaryCache } from './contracts/wallet-summary-cache.js';
import type { WalletSummaryInvalidationRepository } from './contracts/wallet-summary-invalidation.repository.js';

/** Recover committed wallet/ledger outbox versions before enabling local display-cache reads. */
export class PostgresWalletSummaryInvalidationRepository
  extends PostgresCacheInvalidationDelivery<DatabaseSchema>
  implements WalletSummaryInvalidationRepository
{
  /** Borrow the bounded recovery connection and wallet cache, with no business transaction participation. */
  constructor(database: Kysely<DatabaseSchema>, cache: WalletSummaryCache) {
    super(database, cache, 'walletSummary');
  }
}
