/** Verify the forward conversion migration preserves funded wallets, reserved payments and immutable existing provider identities. */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { startWalletTestDatabase } from '../support/wallet-test-database.js';
import { WalletRepositoryImpl } from '../../src/modules/wallets/repositories/wallet.repository.impl.js';
import { WalletPostgresDataSource } from '../../src/modules/wallets/data-sources/postgres/wallet.postgres.data-source.js';
import { WalletService } from '../../src/modules/wallets/services/wallet.service.js';
import { WalletReservationService } from '../../src/modules/wallets/services/wallet-reservation.service.js';
import { PostgresFundingRepository } from '../../src/modules/wallet-funding/repositories/postgres-funding.repository.js';
import { PostgresPaymentRepository } from '../../src/modules/payments/repositories/postgres-payment.repository.js';
import { paymentTermsFingerprint } from '../../src/modules/payments/domain/payment.js';
import { money } from '../../src/modules/wallets/domain/money.js';

it('preserves old funding evidence, payment terms, journals, funds and reservations when adding conversion', async () => {
  const baseline = await startWalletTestDatabase('202610130008-bank-transfers');
  try {
    await sql`select grant_funding_runtime_access('wallet_runtime'); select grant_service_payments_runtime_access('wallet_runtime')`.execute(
      baseline.administrator,
    );
    const wallets = new WalletRepositoryImpl(
      new WalletPostgresDataSource(baseline.database),
    );
    const ownerId = randomUUID();
    const wallet = await wallets.createWallet(ownerId, 'NGN');
    const partnerAccountId = randomUUID();
    await baseline.administrator
      .insertInto('ledger_accounts')
      .values({
        id: partnerAccountId,
        account_code: `legacy:${partnerAccountId}`,
        account_kind: 'partner_funds',
        currency: 'NGN',
        wallet_id: null,
      })
      .execute();
    const fundingRepository = new PostgresFundingRepository(baseline.database);
    const funding = await fundingRepository.create({
      id: randomUUID(),
      ownerId,
      walletId: wallet.id,
      value: money(200000n, 'NGN'),
      adapterId: 'legacy-collection-realm',
      fundingOptionId: 'legacy-checkout',
      environment: 'test',
      partnerAccountId,
      payerEmail: 'fixture@example.com',
      requestKey: 'original-funding-key',
      requestFingerprint: 'original-funding-fingerprint',
    });
    await fundingRepository.claimInitialization(funding.id);
    await fundingRepository.saveCheckout(
      funding.id,
      'https://checkout.example/legacy',
    );
    await fundingRepository.recordVerifiedPayment(
      funding,
      'original-funding-movement',
    );
    const service = new WalletService(
      wallets,
      {
        /** Existing trusted proof posts only its original value and movement identity. */
        async verifyFunding() {
          return {
            walletId: wallet.id,
            partnerAccountId,
            externalMovementId: 'original-funding-movement',
            evidenceReference: 'original-proof',
            value: funding.value,
          };
        },
      },
      new WalletReservationService(wallets, undefined),
    );
    await service.confirmWalletFunding('original-proof');
    const productId = randomUUID();
    const quoteId = randomUUID();
    const paymentId = randomUUID();
    const createdAt = new Date();
    await baseline.administrator
      .insertInto('service_catalog_products')
      .values({
        id: productId,
        service_type: 'airtime',
        network_code: 'legacy-network',
        display_name: 'Existing airtime product',
        currency: 'NGN',
        fixed_price_minor_units: null,
        minimum_amount_minor_units: 100n,
        maximum_amount_minor_units: 100000n,
        amount_step_minor_units: 100n,
        fee_minor_units: 0n,
        allowance_label: null,
        validity_seconds: null,
        quote_lifetime_seconds: 300,
        provider_key: 'legacy-payment-realm',
        provider_product_code: 'legacy-airtime-sku',
        is_enabled: true,
      })
      .execute();
    await baseline.administrator
      .insertInto('service_payment_quotes')
      .values({
        id: quoteId,
        owner_id: ownerId,
        wallet_id: wallet.id,
        product_id: productId,
        recipient_phone_number: '+2348012345678',
        currency: 'NGN',
        principal_minor_units: 2000n,
        fee_minor_units: 0n,
        total_debit_minor_units: 2000n,
        created_at: createdAt,
        expires_at: new Date(createdAt.getTime() + 300000),
      })
      .execute();
    await baseline.administrator
      .insertInto('service_payments')
      .values({
        id: paymentId,
        owner_id: ownerId,
        quote_id: quoteId,
        request_key: 'original-payment-key',
        partner_account_id: partnerAccountId,
        fee_account_id: null,
      })
      .execute();
    await service.reserveWalletFunds({
      actorId: ownerId,
      walletId: wallet.id,
      requestKey: 'original-payment-reservation',
      paymentReference: paymentId,
      value: money(2000n, 'NGN'),
    });
    const payments = new PostgresPaymentRepository(baseline.database);
    const beforeWallet = await service.getWalletBalance({
      actorId: ownerId,
      walletId: wallet.id,
    });
    const beforeFunding = await fundingRepository.get(funding.id);
    const beforePayment = await payments.getPayment(paymentId);
    const beforeEntries = await baseline.database
      .selectFrom('ledger_entries')
      .selectAll()
      .orderBy('journal_id')
      .orderBy('line_number')
      .execute();
    expect(beforeWallet.availableMinorUnits).toBe(198000n);
    expect(beforeWallet.reservedMinorUnits).toBe(2000n);
    expect(beforeFunding!.operationId).toBeTruthy();
    expect((await baseline.migrator.migrateToLatest()).error).toBeUndefined();
    await sql`select grant_airtime_conversion_runtime_access('wallet_runtime')`.execute(
      baseline.administrator,
    );
    expect(
      await service.getWalletBalance({ actorId: ownerId, walletId: wallet.id }),
    ).toEqual(beforeWallet);
    expect(await fundingRepository.get(funding.id)).toEqual(beforeFunding);
    const afterPayment = await payments.getPayment(paymentId);
    expect(afterPayment).toEqual(beforePayment);
    expect(paymentTermsFingerprint(afterPayment!)).toBe(
      paymentTermsFingerprint(beforePayment!),
    );
    expect(
      await baseline.database
        .selectFrom('ledger_entries')
        .selectAll()
        .orderBy('journal_id')
        .orderBy('line_number')
        .execute(),
    ).toEqual(beforeEntries);
    expect(
      await baseline.database
        .selectFrom('airtime_conversion_quotes')
        .selectAll()
        .execute(),
    ).toEqual([]);
    expect(
      await baseline.database
        .selectFrom('airtime_conversions')
        .selectAll()
        .execute(),
    ).toEqual([]);
    expect(
      await baseline.database
        .selectFrom('airtime_conversion_outcomes')
        .selectAll()
        .execute(),
    ).toEqual([]);
  } finally {
    await baseline.stop();
  }
});
