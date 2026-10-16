/** Prove the provider-neutral upgrade preserves accepted requests and verified economic identities. */
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { startWalletTestDatabase } from '../../../../packages/backend/tests/support/wallet-test-database.js';
import { DatabaseConnection } from '@axiapay/backend/infrastructure/database/database.module';
import { WalletModule } from '@axiapay/backend/modules/wallets/wallet.module';
import { WalletService } from '@axiapay/backend/modules/wallets/services/wallet.service';
import { FundingService } from '../../src/modules/wallet-funding/services/funding.service.js';
import { PostgresFundingRepository } from '../../src/modules/wallet-funding/repositories/postgres-funding.repository.js';

it('upgrades existing OPay/Paystack history without changing financial terms, claims, fingerprints or verified payments', async () => {
  const database = await startWalletTestDatabase('202610130002-wallet-funding');
  const module = await Test.createTestingModule({ imports: [WalletModule] })
    .overrideProvider(DatabaseConnection)
    .useValue({ database: database.database })
    .compile();
  try {
    const ownerId = randomUUID();
    const wallet = await module
      .get(WalletService)
      .createWallet({ actorId: ownerId, currency: 'NGN' });
    const accountId = randomUUID();
    const fundingId = randomUUID();
    const requestKey = randomUUID();
    await database.administrator
      .insertInto('ledger_accounts')
      .values({
        id: accountId,
        account_code: 'legacy:paystack',
        currency: 'NGN',
        account_kind: 'partner_funds',
        wallet_id: null,
      })
      .execute();
    const fingerprint = JSON.stringify([
      wallet.id,
      'paystack',
      'test',
      accountId,
      'NGN',
      '10000',
      'payer@example.com',
    ]);
    await sql`insert into wallet_funding_requests (id, owner_id, wallet_id, currency, amount_minor_units, partner, environment, partner_account_id, payer_email, request_key, request_fingerprint, initialization_started_at, checkout_url)
      values (${fundingId}, ${ownerId}, ${wallet.id}, 'NGN', 10000, 'paystack', 'test', ${accountId}, 'payer@example.com', ${requestKey}, ${fingerprint}, now(), 'https://checkout.example/legacy')`.execute(
      database.administrator,
    );
    await sql`insert into wallet_funding_payments (funding_request_id, partner, environment, external_movement_id) values (${fundingId}, 'paystack', 'test', 'legacy-movement');`.execute(
      database.administrator,
    );
    const before = await sql<
      Record<string, unknown>
    >`select * from wallet_funding_requests where id = ${fundingId}`.execute(
      database.administrator,
    );
    const verifiedBefore = await database.administrator
      .selectFrom('wallet_funding_payments')
      .selectAll()
      .execute();
    const migration = await database.migrator.migrateToLatest();
    expect(migration.error).toBeUndefined();
    const after = await database.administrator
      .selectFrom('wallet_funding_requests')
      .selectAll()
      .where('id', '=', fundingId)
      .executeTakeFirstOrThrow();
    expect(after).toEqual({
      ...before.rows[0],
      funding_option_id: 'paystack-checkout',
    });
    expect(
      await database.administrator
        .selectFrom('wallet_funding_payments')
        .selectAll()
        .execute(),
    ).toEqual(verifiedBefore);
    await sql`select grant_funding_runtime_access('wallet_runtime')`.execute(
      database.administrator,
    );
    const service = new FundingService(
      new PostgresFundingRepository(database.database),
      [],
    );
    const replay = await service.initialize({
      actorId: ownerId,
      walletId: wallet.id,
      fundingOptionId: 'paystack-checkout',
      value: { currency: 'NGN', amountMinorUnits: 10000n },
      payerEmail: 'payer@example.com',
      requestKey,
    });
    expect(replay.id).toBe(fundingId);
    expect(replay.requestFingerprint).toBe(fingerprint);
    expect(replay.externalMovementId).toBe('legacy-movement');
    await expect(
      database.administrator
        .updateTable('wallet_funding_requests')
        .set({ funding_option_id: 'replacement' })
        .where('id', '=', fundingId)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
  } finally {
    await module.close();
    await database.stop();
  }
});
