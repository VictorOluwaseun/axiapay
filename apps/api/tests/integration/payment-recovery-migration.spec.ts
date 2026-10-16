/** Verify recovery backfill preserves existing real holds, balances and submission identities. */
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { sql } from 'kysely';
import { Test, type TestingModule } from '@nestjs/testing';
import { startWalletTestDatabase } from '../../../../packages/payments-runtime/tests/support/wallet-test-database.js';
import { WalletRepositoryImpl } from '@axiapay/payments-runtime/modules/wallets/repositories/wallet.repository.impl';
import { WalletDataSource } from '@axiapay/payments-runtime/modules/wallets/data-sources/wallet.data-source';
import { WalletModule } from '@axiapay/payments-runtime/modules/wallets/wallet.module';
import { WalletService } from '@axiapay/payments-runtime/modules/wallets/services/wallet.service';
import { DatabaseConnection } from '@axiapay/payments-runtime/infrastructure/database/database.module';
import { money } from '@axiapay/payments-runtime/modules/wallets/domain/money';
import { PostgresPaymentRecoveryRepository } from '@axiapay/payments-runtime/modules/payments/repositories/postgres-payment-recovery.repository';

it('backfills a real unresolved hold without moving money or granting permission to delete recovery history', async () => {
  const database = await startWalletTestDatabase(
    '202610150010-password-recovery',
  );
  let module: TestingModule | undefined;
  try {
    const wallets = new WalletRepositoryImpl(
      new WalletDataSource(database.database),
    );
    const ownerId = randomUUID();
    const wallet = await wallets.createWallet(ownerId, 'NGN');
    const productId = randomUUID();
    const quoteId = randomUUID();
    const paymentId = randomUUID();
    const partnerAccountId = randomUUID();
    const createdAt = new Date('2030-01-01T00:00:00Z');
    await database.administrator
      .insertInto('ledger_accounts')
      .values({
        id: partnerAccountId,
        account_code: `migration:${partnerAccountId}`,
        account_kind: 'partner_funds',
        currency: 'NGN',
        wallet_id: null,
      })
      .execute();
    await database.administrator
      .insertInto('service_catalog_products')
      .values({
        id: productId,
        service_type: 'airtime',
        network_code: 'migration-test',
        display_name: 'Existing airtime',
        currency: 'NGN',
        fixed_price_minor_units: null,
        minimum_amount_minor_units: 100n,
        maximum_amount_minor_units: 100_000n,
        amount_step_minor_units: 100n,
        fee_minor_units: 0n,
        allowance_label: null,
        validity_seconds: null,
        quote_lifetime_seconds: 300,
        provider_key: 'migration-test-realm',
        provider_product_code: 'existing-sku',
        is_enabled: true,
      })
      .execute();
    await database.administrator
      .insertInto('service_payment_quotes')
      .values({
        id: quoteId,
        owner_id: ownerId,
        wallet_id: wallet.id,
        product_id: productId,
        recipient_phone_number: '+2348012345678',
        currency: 'NGN',
        principal_minor_units: 1000n,
        fee_minor_units: 0n,
        total_debit_minor_units: 1000n,
        created_at: createdAt,
        expires_at: new Date(createdAt.getTime() + 300_000),
      })
      .execute();
    await database.administrator
      .insertInto('service_payments')
      .values({
        id: paymentId,
        owner_id: ownerId,
        quote_id: quoteId,
        request_key: 'existing-request',
        partner_account_id: partnerAccountId,
        fee_account_id: null,
      })
      .execute();

    module = await Test.createTestingModule({
      imports: [
        WalletModule.register({
          funding: {
            /** Supply only controlled funding evidence for this test's wallet. */
            async verifyFunding(reference) {
              return {
                walletId: wallet.id,
                partnerAccountId,
                externalMovementId: reference,
                evidenceReference: reference,
                value: money(100_000n, 'NGN'),
              };
            },
          },
          paymentOutcome: {
            /** No outcome or release is authorized by this upgrade test. */
            async verifyOutcome() {
              throw new Error('No outcome in this migration test');
            },
          },
        }),
      ],
    })
      .overrideProvider(DatabaseConnection)
      .useValue({ database: database.database })
      .compile();
    const service = module.get(WalletService);
    await service.confirmWalletFunding(randomUUID());
    await service.reserveWalletFunds({
      actorId: ownerId,
      walletId: wallet.id,
      requestKey: `payment:${paymentId}`,
      paymentReference: paymentId,
      value: money(1000n, 'NGN'),
    });
    const before = await wallets.getWallet(wallet.id);
    const migration = await database.migrator.migrateToLatest();
    expect(migration.error).toBeUndefined();
    await sql`select grant_payment_recovery_runtime_access('wallet_runtime')`.execute(
      database.administrator,
    );
    const recovery = new PostgresPaymentRecoveryRepository(database.database);
    expect(await recovery.getProgress(paymentId)).toMatchObject({
      status: 'pending',
      totalAttempts: 0,
    });
    expect(await wallets.getWallet(wallet.id)).toEqual(before);
    const payment = await database.administrator
      .selectFrom('service_payments')
      .selectAll()
      .where('id', '=', paymentId)
      .executeTakeFirstOrThrow();
    expect(payment.submission_started_at).toBeNull();
    await expect(
      sql`delete from service_payment_recovery where payment_id = ${paymentId}`.execute(
        database.database,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  } finally {
    await module?.close();
    await database.stop();
  }
});
