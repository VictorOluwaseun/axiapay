/** Explicit administrative command; reuse signup wallet policy and ledger provisioning without running during API startup. */
import { createDatabase } from '@axiapay/payments-runtime/infrastructure/database/create-database';
import { PostgresAccountWalletProvisioningRepository } from '../../modules/authentication/repositories/postgres-account-wallet-provisioning.repository.js';
import { VerifiedWalletBackfillService } from '../../modules/authentication/services/verified-wallet-backfill.service.js';

/** Ensure wallets using configured database privileges; log counts only, and leave committed progress safe to retry on failure. */
async function backfillVerifiedWallets(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to backfill wallets.');
  }
  const database = createDatabase(connectionString);
  try {
    const service = new VerifiedWalletBackfillService(
      new PostgresAccountWalletProvisioningRepository(database),
    );
    console.info({
      event: 'verified_wallet_backfill_complete',
      ...(await service.run()),
    });
  } catch (cause) {
    console.error({
      event: 'verified_wallet_backfill_failed',
      recovery: 'retry_same_command',
      errorKind: cause instanceof Error ? cause.name : 'UnknownError',
    });
    process.exitCode = 1;
  } finally {
    await database.destroy();
  }
}

await backfillVerifiedWallets();
