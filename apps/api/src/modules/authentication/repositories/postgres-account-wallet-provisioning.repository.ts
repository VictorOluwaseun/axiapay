import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '@axiapay/payments-runtime/infrastructure/database/create-database';
import { WalletDataSource } from '@axiapay/payments-runtime/modules/wallets/data-sources/wallet.data-source';
import { WalletRepositoryImpl } from '@axiapay/payments-runtime/modules/wallets/repositories/wallet.repository.impl';
import type { AccountWalletProvisioningRepository } from './contracts/account-wallet-provisioning.repository.js';

/** Read verified account IDs directly from PostgreSQL and coordinate existing wallet persistence in an account-bound transaction. */
export class PostgresAccountWalletProvisioningRepository implements AccountWalletProvisioningRepository {
  /** Borrow the administrative command's managed pool; no cache, password or session reads are involved. */
  constructor(private readonly database: Kysely<DatabaseSchema>) {}

  /** @inheritdoc AccountWalletProvisioningRepository.findVerifiedAccountIds */
  async findVerifiedAccountIds(
    afterAccountId: string | null,
    limit: number,
  ): Promise<readonly string[]> {
    let query = this.database
      .selectFrom('auth_accounts')
      .select('id')
      .where('verified_at', 'is not', null)
      .orderBy('id')
      .limit(limit);
    if (afterAccountId !== null) {
      query = query.where('id', '>', afterAccountId);
    }
    return (await query.execute()).map((account) => account.id);
  }

  /** @inheritdoc AccountWalletProvisioningRepository.ensureWallet */
  async ensureWallet(accountId: string, currency: string): Promise<boolean> {
    return this.database.transaction().execute(async (transaction) => {
      const account = await transaction
        .selectFrom('auth_accounts')
        .select('id')
        .where('id', '=', accountId)
        .where('verified_at', 'is not', null)
        .forShare()
        .executeTakeFirst();
      if (!account) {
        return false;
      }
      const wallets = new WalletRepositoryImpl(
        new WalletDataSource(transaction),
      );
      await wallets.createWallet(account.id, currency);
      return true;
    });
  }
}
