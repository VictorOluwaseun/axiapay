/** Verify the forward bill migration preserves existing mobile quotes, payment identities, fingerprints and authoritative wallet balances. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  startWalletTestDatabase,
  type WalletTestDatabase,
} from '../../../../packages/payments-runtime/tests/support/wallet-test-database.js';
import { WalletRepositoryImpl } from '@axiapay/payments-runtime/modules/wallets/repositories/wallet.repository.impl';
import { WalletDataSource } from '@axiapay/payments-runtime/modules/wallets/data-sources/wallet.data-source';
import { PostgresPaymentRepository } from '@axiapay/payments-runtime/modules/payments/repositories/postgres-payment.repository';
import {
  paymentTermsFingerprint,
  paymentStatus,
} from '@axiapay/payments-runtime/modules/payments/domain/payment';

let database: WalletTestDatabase;
beforeAll(async () => {
  database = await startWalletTestDatabase(
    '202610130005-provider-neutral-funding',
  );
});
afterAll(async () => {
  await database?.stop();
});

it('preserves accepted mobile history and its original adapter correlation after upgrading', async () => {
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
  const before = await database.administrator
    .selectFrom('service_payment_quotes')
    .select([
      'id',
      'principal_minor_units',
      'recipient_phone_number',
      'expires_at',
    ])
    .where('id', '=', quoteId)
    .executeTakeFirstOrThrow();
  const result = await database.migrator.migrateToLatest();
  expect(result.error).toBeUndefined();
  await sql`select grant_service_payments_runtime_access('wallet_runtime')`.execute(
    database.administrator,
  );
  const after = await database.database
    .selectFrom('service_payment_quotes')
    .select([
      'id',
      'principal_minor_units',
      'recipient_phone_number',
      'expires_at',
    ])
    .where('id', '=', quoteId)
    .executeTakeFirstOrThrow();
  expect(after).toEqual(before);
  const payment = await new PostgresPaymentRepository(
    database.database,
  ).getPayment(paymentId);
  expect(payment).not.toBeNull();
  expect(payment!.quote.accountValidation).toBeNull();
  expect(payment!.fulfilment).toBeNull();
  expect(paymentStatus(payment!)).toBe('awaiting_funds');
  expect(paymentTermsFingerprint(payment!)).toBe(
    JSON.stringify([
      paymentId,
      productId,
      'migration-test-realm',
      'existing-sku',
      '+2348012345678',
      'NGN',
      '1000',
      '0',
    ]),
  );
  expect(await wallets.getWallet(wallet.id)).toEqual(wallet);
});

it('preserves existing TV recipient evidence, receipt and correlation when adding education and insurance', async () => {
  const baseline = await startWalletTestDatabase('202610130006-tv-electricity');
  try {
    const wallets = new WalletRepositoryImpl(
      new WalletDataSource(baseline.database),
    );
    const ownerId = randomUUID();
    const wallet = await wallets.createWallet(ownerId, 'NGN');
    const productId = randomUUID();
    const validationId = randomUUID();
    const quoteId = randomUUID();
    const paymentId = randomUUID();
    const partnerAccountId = randomUUID();
    const createdAt = new Date('2030-01-01T00:00:00Z');
    const expiresAt = new Date(createdAt.getTime() + 120_000);
    await baseline.administrator
      .insertInto('ledger_accounts')
      .values({
        id: partnerAccountId,
        account_code: `migration:${partnerAccountId}`,
        account_kind: 'partner_funds',
        currency: 'NGN',
        wallet_id: null,
      })
      .execute();
    await baseline.administrator
      .insertInto('service_catalog_products')
      .values({
        id: productId,
        service_type: 'tv',
        network_code: null,
        biller_code: 'existing-tv',
        electricity_meter_type: null,
        account_validation_lifetime_seconds: 120,
        display_name: 'Existing package',
        currency: 'NGN',
        fixed_price_minor_units: 12_500n,
        minimum_amount_minor_units: 12_500n,
        maximum_amount_minor_units: 12_500n,
        amount_step_minor_units: 100n,
        fee_minor_units: 0n,
        allowance_label: null,
        validity_seconds: null,
        quote_lifetime_seconds: 300,
        provider_key: 'existing-tv-realm',
        provider_product_code: 'existing-tv-sku',
        is_enabled: true,
      })
      .execute();
    await baseline.administrator
      .insertInto('service_bill_account_validations')
      .values({
        id: validationId,
        owner_id: ownerId,
        product_id: productId,
        account_number: '00012345',
        customer_name: 'Existing Household',
        service_address: null,
        evidence_reference: 'existing-verification',
        verified_at: createdAt,
        expires_at: expiresAt,
      })
      .execute();
    await baseline.administrator
      .insertInto('service_payment_quotes')
      .values({
        id: quoteId,
        owner_id: ownerId,
        wallet_id: wallet.id,
        product_id: productId,
        recipient_phone_number: null,
        account_validation_id: validationId,
        currency: 'NGN',
        principal_minor_units: 12_500n,
        fee_minor_units: 0n,
        total_debit_minor_units: 12_500n,
        created_at: createdAt,
        expires_at: expiresAt,
      })
      .execute();
    // Seed submitted historical evidence as the migration owner; this test exercises representation compatibility, not fresh financial authorization.
    await baseline.administrator
      .insertInto('service_payments')
      .values({
        id: paymentId,
        owner_id: ownerId,
        quote_id: quoteId,
        request_key: 'existing-tv-request',
        partner_account_id: partnerAccountId,
        fee_account_id: null,
        submission_started_at: createdAt,
      })
      .execute();
    await baseline.administrator
      .insertInto('service_payment_outcomes')
      .values({
        payment_id: paymentId,
        provider_key: 'existing-tv-realm',
        outcome: 'succeeded',
        provider_transaction_reference: 'existing-tv-movement',
        evidence_reference: 'existing-tv-receipt',
      })
      .execute();
    const receipt = {
      fulfilmentType: 'tv_subscription',
      activationReference: 'existing-activation',
      renewalAt: null,
    };
    await baseline.administrator
      .insertInto('service_payment_fulfilments')
      .values({
        payment_id: paymentId,
        fulfilment: sql`${JSON.stringify(receipt)}::jsonb`,
      })
      .execute();
    const result = await baseline.migrator.migrateToLatest();
    expect(result.error).toBeUndefined();
    await sql`select grant_service_payments_runtime_access('wallet_runtime')`.execute(
      baseline.administrator,
    );
    const payment = await new PostgresPaymentRepository(
      baseline.database,
    ).getPayment(paymentId);
    expect(payment!.quote.accountValidation).toMatchObject({
      id: validationId,
      accountNumber: '00012345',
      customerName: 'Existing Household',
    });
    expect(payment!.quote.educationValidation).toBeNull();
    expect(payment!.quote.insuranceApplication).toBeNull();
    expect(payment!.fulfilment).toEqual(receipt);
    expect(payment!.documents).toEqual([]);
    expect(paymentTermsFingerprint(payment!)).toBe(
      JSON.stringify([
        paymentId,
        productId,
        'existing-tv-realm',
        'existing-tv-sku',
        null,
        'NGN',
        '12500',
        '0',
        validationId,
        '00012345',
        'existing-tv',
        null,
      ]),
    );
    expect(await wallets.getWallet(wallet.id)).toEqual(wallet);
  } finally {
    await baseline.stop();
  }
});

it('preserves existing insurance consent, policy/document evidence and fingerprints when adding bank transfers', async () => {
  const baseline = await startWalletTestDatabase(
    '202610130007-education-insurance',
  );
  try {
    const wallets = new WalletRepositoryImpl(
      new WalletDataSource(baseline.database),
    );
    const ownerId = randomUUID();
    const wallet = await wallets.createWallet(ownerId, 'NGN');
    const productId = randomUUID();
    const applicationId = randomUUID();
    const quoteId = randomUUID();
    const paymentId = randomUUID();
    const partnerAccountId = randomUUID();
    const createdAt = new Date('2030-01-01T00:00:00Z');
    const expiresAt = new Date(createdAt.getTime() + 120_000);
    const insuredProfile = { fullName: 'Existing Insured' };
    const policy = {
      fulfilmentType: 'insurance_policy',
      policyNumber: '000-existing-policy',
      insuredName: 'Existing Insured',
      coverageStartsOn: '2030-01-01',
      coverageEndsOn: '2031-01-01',
    };
    const terms = {
      version: 'existing-terms',
      coverageSummary: 'Existing coverage',
      exclusions: [],
      coverageDurationDays: 365,
      cancellationRefundTerms: 'Existing cancellation rules',
      requiredInsuredFields: ['fullName'],
      optionalInsuredFields: [],
    };
    await baseline.administrator
      .insertInto('ledger_accounts')
      .values({
        id: partnerAccountId,
        account_code: `migration:${partnerAccountId}`,
        account_kind: 'partner_funds',
        currency: 'NGN',
        wallet_id: null,
      })
      .execute();
    await baseline.administrator
      .insertInto('service_catalog_products')
      .values({
        id: productId,
        service_type: 'insurance',
        network_code: null,
        biller_code: 'existing-insurer',
        insurance_terms: sql`${JSON.stringify(terms)}::jsonb`,
        insurance_application_lifetime_seconds: 120,
        display_name: 'Existing insurance',
        currency: 'NGN',
        fixed_price_minor_units: 12_500n,
        minimum_amount_minor_units: 12_500n,
        maximum_amount_minor_units: 12_500n,
        amount_step_minor_units: 100n,
        fee_minor_units: 0n,
        allowance_label: null,
        validity_seconds: null,
        quote_lifetime_seconds: 300,
        provider_key: 'existing-insurance-realm',
        provider_product_code: 'existing-insurance-sku',
        is_enabled: true,
      })
      .execute();
    await baseline.administrator
      .insertInto('service_insurance_applications')
      .values({
        id: applicationId,
        owner_id: ownerId,
        product_id: productId,
        insured_profile: sql`${JSON.stringify(insuredProfile)}::jsonb`,
        terms_version: terms.version,
        accepted_terms: true,
        coverage_starts_on: policy.coverageStartsOn,
        coverage_ends_on: policy.coverageEndsOn,
        evidence_reference: 'existing-eligibility',
        created_at: createdAt,
        expires_at: expiresAt,
      })
      .execute();
    await baseline.administrator
      .insertInto('service_payment_quotes')
      .values({
        id: quoteId,
        owner_id: ownerId,
        wallet_id: wallet.id,
        product_id: productId,
        recipient_phone_number: null,
        insurance_application_id: applicationId,
        currency: 'NGN',
        principal_minor_units: 12_500n,
        fee_minor_units: 0n,
        total_debit_minor_units: 12_500n,
        created_at: createdAt,
        expires_at: expiresAt,
      })
      .execute();
    // Historical submitted proof is seeded by the migration owner; fresh authorization and financial invariants are exercised by the HTTP integration suite.
    await baseline.administrator
      .insertInto('service_payments')
      .values({
        id: paymentId,
        owner_id: ownerId,
        quote_id: quoteId,
        request_key: 'existing-insurance-request',
        partner_account_id: partnerAccountId,
        fee_account_id: null,
        submission_started_at: createdAt,
      })
      .execute();
    await baseline.administrator
      .insertInto('service_payment_outcomes')
      .values({
        payment_id: paymentId,
        provider_key: 'existing-insurance-realm',
        outcome: 'succeeded',
        provider_transaction_reference: 'existing-premium-movement',
        evidence_reference: 'existing-premium-evidence',
      })
      .execute();
    await baseline.administrator
      .insertInto('service_payment_fulfilments')
      .values({
        payment_id: paymentId,
        fulfilment: sql`${JSON.stringify(policy)}::jsonb`,
      })
      .execute();
    await baseline.administrator
      .insertInto('service_payment_documents')
      .values({
        payment_id: paymentId,
        document_id: 'policy',
        document_type: 'policy',
        display_name: 'Existing issued policy',
        content_type: 'application/pdf',
        provider_document_reference: 'private-existing-policy',
      })
      .execute();
    const result = await baseline.migrator.migrateToLatest();
    expect(result.error).toBeUndefined();
    await sql`select grant_service_payments_runtime_access('wallet_runtime')`.execute(
      baseline.administrator,
    );
    const payment = await new PostgresPaymentRepository(
      baseline.database,
    ).getPayment(paymentId);
    expect(payment!.quote.bankBeneficiaryValidation).toBeNull();
    expect(payment!.quote.narration).toBeNull();
    expect(payment!.quote.insuranceApplication).toMatchObject({
      id: applicationId,
      insuredProfile,
      termsVersion: terms.version,
      coverageStartsOn: policy.coverageStartsOn,
      coverageEndsOn: policy.coverageEndsOn,
    });
    expect(payment!.fulfilment).toEqual(policy);
    expect(payment!.documents).toEqual([
      {
        documentId: 'policy',
        documentType: 'policy',
        displayName: 'Existing issued policy',
        contentType: 'application/pdf',
        providerDocumentReference: 'private-existing-policy',
      },
    ]);
    expect(paymentTermsFingerprint(payment!)).toBe(
      JSON.stringify([
        paymentId,
        productId,
        'existing-insurance-realm',
        'existing-insurance-sku',
        null,
        'NGN',
        '12500',
        '0',
        applicationId,
        JSON.stringify([
          'Existing Insured',
          null,
          null,
          null,
          null,
          null,
          null,
        ]),
        terms.version,
        policy.coverageStartsOn,
        policy.coverageEndsOn,
        'existing-insurer',
      ]),
    );
    expect(await wallets.getWallet(wallet.id)).toEqual(wallet);
    expect(
      await baseline.database
        .selectFrom('bank_transfer_banks')
        .select('id')
        .execute(),
    ).toEqual([]);
  } finally {
    await baseline.stop();
  }
});
