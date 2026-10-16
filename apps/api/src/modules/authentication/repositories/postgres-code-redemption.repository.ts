import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '@axiapay/payments-runtime/infrastructure/database/create-database';
import { WalletDataSource } from '@axiapay/payments-runtime/modules/wallets/data-sources/wallet.data-source';
import { WalletRepositoryImpl } from '@axiapay/payments-runtime/modules/wallets/repositories/wallet.repository.impl';
import type { WalletRepository } from '@axiapay/payments-runtime/modules/wallets/repositories/contracts/wallet.repository';
import { AuthenticationRepositoryImpl } from './authentication.repository.impl.js';
import type { AuthenticationRepository } from './contracts/authentication.repository.js';
import type { AuthenticationDatabase } from './authentication-database.js';
import type { CodeRedemptionRepository } from './contracts/code-redemption.repository.js';
import type { SessionCacheInvalidationRepository } from './contracts/session-cache-invalidation.repository.js';

/** Bind the existing PostgreSQL repositories to one code-redemption transaction; all feature SQL stays in its owner. */
export class PostgresCodeRedemptionRepository implements CodeRedemptionRepository {
  /** Borrow the lifecycle-managed pool; only transaction-scoped repositories enter the workflow. */
  constructor(
    private readonly database: Kysely<DatabaseSchema>,
    private readonly invalidations?: SessionCacheInvalidationRepository,
  ) {}

  /** @inheritdoc CodeRedemptionRepository.transaction */
  async transaction<Result>(
    work: (
      authentication: AuthenticationRepository,
      wallets: Pick<WalletRepository, 'createWallet'>,
    ) => Promise<Result>,
  ): Promise<Result> {
    const result = await this.database
      .transaction()
      .execute((transaction) =>
        work(
          new AuthenticationRepositoryImpl(
            transaction.$pickTables<keyof AuthenticationDatabase>(),
          ),
          new WalletRepositoryImpl(new WalletDataSource(transaction)),
        ),
      );
    await this.invalidations?.flush();
    return result;
  }
}
