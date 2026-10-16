import { PaymentRecoveryService } from '@axiapay/payments-runtime/modules/payments/services/payment-recovery.service';
import { PostgresPaymentRecoveryRepository } from '@axiapay/payments-runtime/modules/payments/repositories/postgres-payment-recovery.repository';
/** Verify the first-party airtime/data contract, real PostgreSQL invariants and recovery using test-only fulfilment adapters. */
import { AxiosError, type AxiosAdapter } from 'axios';
import { axiosTextResponse } from '../../../../packages/payments-runtime/tests/support/axios-response-fixture.js';
import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RequestValidationModule } from '../../src/bootstrap/request-validation.module.js';
import { validateEnvironment } from '../../src/infrastructure/config/environment.js';
import { DatabaseConnection } from '@axiapay/payments-runtime/infrastructure/database/database.module';
import { AUTHENTICATION } from '../../src/modules/authentication/authentication.tokens.js';
import type { AuthenticationResult } from '../../src/modules/authentication/services/authentication-session.js';
import { PaymentsModule } from '../../src/modules/payments/payments.module.js';
import { PAYMENTS } from '@axiapay/payments-runtime/modules/payments/payments.tokens';
import {
  PaymentError,
  paymentTermsFingerprint,
  type ServicePayment,
} from '@axiapay/payments-runtime/modules/payments/domain/payment';
import { PostgresPaymentRepository } from '@axiapay/payments-runtime/modules/payments/repositories/postgres-payment.repository';
import { PaymentExecutionService } from '@axiapay/payments-runtime/modules/payments/services/payment-execution.service';
import { AirtimeProcessor } from '@axiapay/payments-runtime/modules/payments/processors/airtime.processor';
import { VtpassAirtimeAdapter } from '@axiapay/payments-runtime/modules/payments/adapters/vtpass-airtime.adapter';
import { parseVtpassJson } from '@axiapay/payments-runtime/modules/payments/adapters/vtpass-airtime.protocol';
import type {
  PaymentProviderRegistration,
  ProviderPaymentResult,
} from '@axiapay/payments-runtime/modules/payments/ports/service-payment-provider';
import type { PaymentQuoteResponseDto } from '../../src/modules/payments/dtos/payment-response.dto.js';
import { WalletModule } from '@axiapay/payments-runtime/modules/wallets/wallet.module';
import { WalletService } from '@axiapay/payments-runtime/modules/wallets/services/wallet.service';
import type { ConfirmedFunding } from '@axiapay/payments-runtime/modules/wallets/ports/wallet-verification';
import { money } from '@axiapay/payments-runtime/modules/wallets/domain/money';
import type {
  ServiceType,
  ServiceProduct,
  ElectricityMeterType,
  EducationPaymentType,
} from '@axiapay/payments-runtime/modules/service-catalog/domain/service-product';
import type { BillAccountVerificationResult } from '@axiapay/payments-runtime/modules/payments/ports/bill-account-verification';
import type { BillAccountValidationResponseDto } from '../../src/modules/payments/dtos/bill-account.dto.js';
import type { InsuranceProductTerms } from '@axiapay/payments-runtime/modules/service-catalog/domain/insurance-product-terms';
import type {
  EducationBeneficiaryVerification,
  EducationBeneficiaryResult,
} from '@axiapay/payments-runtime/modules/payments/ports/education-beneficiary-verification';
import type {
  InsuranceEligibility,
  InsuranceEligibilityResult,
} from '@axiapay/payments-runtime/modules/payments/ports/insurance-eligibility';
import type {
  PaymentDocumentRetrieval,
  RetrievedPaymentDocument,
} from '@axiapay/payments-runtime/modules/payments/ports/payment-document-retrieval';
import type {
  BankBeneficiaryVerification,
  BankBeneficiaryResult,
} from '@axiapay/payments-runtime/modules/payments/ports/bank-beneficiary-verification';
import type { PaymentDocument } from '@axiapay/payments-runtime/modules/payments/domain/payment-document';
import type { PaymentFulfilment } from '@axiapay/payments-runtime/modules/payments/domain/payment-fulfilment';
import {
  startWalletTestDatabase,
  type WalletTestDatabase,
} from '../../../../packages/payments-runtime/tests/support/wallet-test-database.js';

let database: WalletTestDatabase;
let application: NestFastifyApplication;
let trustedModule: TestingModule;
let wallets: WalletService;
let trustedWallets: WalletService;
let currentTime = new Date('2030-01-01T00:00:00Z');
const registrations: Record<string, PaymentProviderRegistration | undefined> =
  {};
const codes = new Map<string, string>();
const fundingEvidence = new Map<string, ConfirmedFunding>();

beforeAll(async () => {
  database = await startWalletTestDatabase();
  await sql`select grant_service_payments_runtime_access('wallet_runtime');
    select grant_payment_recovery_runtime_access('wallet_runtime');
    grant select, insert, update, delete on auth_accounts, auth_sessions, auth_challenges, auth_rate_limits to wallet_runtime;`.execute(
    database.administrator,
  );
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        ignoreEnvFile: true,
        validate: validateEnvironment,
      }),
      RequestValidationModule,
      PaymentsModule.register(),
    ],
  })
    .overrideProvider(DatabaseConnection)
    .useValue({ database: database.database })
    .overrideProvider(AUTHENTICATION.codeDelivery)
    .useValue({
      /** Capture verification codes privately through the real authentication delivery port. */
      async send(message: { challengeId: string; code: string }) {
        codes.set(message.challengeId, message.code);
      },
    })
    .overrideProvider(AUTHENTICATION.clock)
    .useValue({
      /** Keep test sessions valid while advancing quote expiry deliberately. */
      now: () => new Date(currentTime),
    })
    .overrideProvider(PAYMENTS.clock)
    .useValue({
      /** Use a deterministic clock only for acceptance/expiry tests. */
      now: () => new Date(currentTime),
    })
    .overrideProvider(PAYMENTS.providers)
    .useValue(registrations)
    .compile();
  application = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    { logger: false },
  );
  application.setGlobalPrefix('v1');
  await application.init();
  await application.getHttpAdapter().getInstance().ready();
  wallets = module.get(WalletService);
  trustedModule = await Test.createTestingModule({
    imports: [
      WalletModule.register({
        funding: {
          /** Fixture credits still require explicit verified evidence and real journal posting. */
          async verifyFunding(reference) {
            const evidence = fundingEvidence.get(reference);
            if (!evidence) {
              throw new Error('Unverified fixture funding.');
            }
            return evidence;
          },
        },
        paymentOutcome: {
          /** Fulfilment verification is exercised in PaymentsModule, never bypassed through this funding fixture. */
          async verifyOutcome() {
            throw new Error('No fixture settlement bypass.');
          },
        },
      }),
    ],
  })
    .overrideProvider(DatabaseConnection)
    .useValue({ database: database.database })
    .compile();
  trustedWallets = trustedModule.get(WalletService);
});

afterAll(async () => {
  await application?.close();
  await trustedModule?.close();
  await database?.stop();
});

/** Isolated authenticated owner, funded ledger and immutable catalogue revisions for one scenario. */
async function fixture(
  serviceType: ServiceType = 'airtime',
  amountToFund = 100_000n,
  maximumAirtimeAmountMinorUnits = 90_000n,
  electricityMeterType: ElectricityMeterType = 'prepaid',
  educationPaymentType: EducationPaymentType = 'institution_fee',
  providerProtocol?: {
    providerKey: string;
    networkCode: string;
    productCode: string;
  },
) {
  currentTime = new Date(currentTime.getTime() + 3_600_000);
  const signup = await application.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: {
      contact: { kind: 'email', value: `${randomUUID()}@example.com` },
    },
  });
  expect(signup.statusCode).toBe(202);
  const challengeId = signup.json().challengeId as string;
  const verified = await application.inject({
    method: 'POST',
    url: '/v1/auth/signup/verify',
    payload: { challengeId, code: codes.get(challengeId) },
  });
  expect(verified.statusCode).toBe(201);
  const session = verified.json<AuthenticationResult>();
  const wallet = await wallets.createWallet({
    actorId: session.account.id,
    currency: 'NGN',
  });
  const partnerAccountId = randomUUID();
  const feeAccountId = randomUUID();
  await database.administrator
    .insertInto('ledger_accounts')
    .values([
      {
        id: partnerAccountId,
        account_code: `test:${partnerAccountId}`,
        account_kind: 'partner_funds',
        wallet_id: null,
        currency: 'NGN',
      },
      {
        id: feeAccountId,
        account_code: `test:${feeAccountId}`,
        account_kind: 'fee_income',
        wallet_id: null,
        currency: 'NGN',
      },
    ])
    .execute();
  if (amountToFund > 0n) {
    const reference = randomUUID();
    fundingEvidence.set(reference, {
      walletId: wallet.id,
      partnerAccountId,
      externalMovementId: reference,
      evidenceReference: reference,
      value: money(amountToFund, 'NGN'),
    });
    await trustedWallets.confirmWalletFunding(reference);
  }
  const providerKey = providerProtocol?.providerKey ?? `test:${randomUUID()}`;
  const productId = randomUUID();
  const networkCode = providerProtocol?.networkCode ?? `test-${randomUUID()}`;
  const isBill = ['tv', 'electricity'].includes(serviceType);
  const hasFixedPrice =
    ['data', 'tv', 'insurance'].includes(serviceType) ||
    (serviceType === 'education' && educationPaymentType === 'voucher');
  const isMobile = ['airtime', 'data'].includes(serviceType);
  const billerCode =
    isMobile || serviceType === 'bank_transfer' ? null : `test-${randomUUID()}`;
  const bankId = serviceType === 'bank_transfer' ? randomUUID() : null;
  const bankCode = `test-${randomUUID()}`;
  if (bankId) {
    await database.administrator
      .insertInto('bank_transfer_banks')
      .values({
        id: bankId,
        bank_code: bankCode,
        display_name: 'Test Bank',
        country_code: 'NG',
        currency: 'NGN',
        minimum_account_number_length: 10,
        maximum_account_number_length: 10,
        is_enabled: true,
      })
      .execute();
  }
  const insuranceTerms: InsuranceProductTerms = {
    version: 'terms-1',
    coverageSummary: 'Test individual cover',
    exclusions: ['Test exclusion'],
    coverageDurationDays: 365,
    cancellationRefundTerms: 'Test cancellation and refund terms',
    requiredInsuredFields: ['fullName', 'identityNumber'],
    optionalInsuredFields: ['dateOfBirth', 'email'],
  };
  await database.administrator
    .insertInto('service_catalog_products')
    .values({
      id: productId,
      service_type: serviceType,
      network_code: isMobile ? networkCode : null,
      education_payment_type:
        serviceType === 'education' ? educationPaymentType : null,
      education_purpose:
        serviceType === 'education' ? 'Test education purpose' : null,
      education_validation_lifetime_seconds:
        serviceType === 'education' ? 120 : null,
      insurance_terms:
        serviceType === 'insurance'
          ? sql`${JSON.stringify(insuranceTerms)}::jsonb`
          : null,
      insurance_application_lifetime_seconds:
        serviceType === 'insurance' ? 120 : null,
      biller_code: billerCode,
      bank_id: bankId,
      bank_beneficiary_validation_lifetime_seconds: bankId ? 120 : null,
      electricity_meter_type:
        serviceType === 'electricity' ? electricityMeterType : null,
      account_validation_lifetime_seconds: isBill ? 120 : null,
      display_name: `Test ${serviceType}`,
      currency: 'NGN',
      fixed_price_minor_units: hasFixedPrice ? 12_500n : null,
      minimum_amount_minor_units: hasFixedPrice ? 12_500n : 100n,
      maximum_amount_minor_units: hasFixedPrice
        ? 12_500n
        : maximumAirtimeAmountMinorUnits,
      amount_step_minor_units: 100n,
      fee_minor_units: 50n,
      allowance_label: serviceType === 'data' ? '1 GB' : null,
      validity_seconds: serviceType === 'data' ? 86_400 : null,
      quote_lifetime_seconds: 300,
      provider_key: providerKey,
      provider_product_code:
        providerProtocol?.productCode ?? `sku:${productId}`,
      is_enabled: true,
    })
    .execute();
  let resultFactory = pending;
  const submit = vi.fn(async (payment: ServicePayment) =>
    resultFactory(payment),
  );
  const lookup = vi.fn(async (payment: ServicePayment) =>
    resultFactory(payment),
  );
  let verificationFactory = verifiedBillAccount;
  const verify = vi.fn(
    async (input: { product: ServiceProduct; accountNumber: string }) =>
      verificationFactory(input),
  );
  /** Return only test-authenticated exact beneficiary correlation. */
  let educationFactory = (
    input: Parameters<EducationBeneficiaryVerification['verify']>[0],
  ): EducationBeneficiaryResult => ({
    productId: input.product.id,
    institutionCode: input.product.billerCode!,
    beneficiaryIdentifier: input.beneficiaryIdentifier,
    verificationStatus: 'verified',
    beneficiaryName: 'Test Student',
    evidenceReference: 'test-education-evidence',
  });
  /** Confirm the complete test application without pricing or purchasing. */
  let eligibilityFactory = (
    input: Parameters<InsuranceEligibility['verify']>[0],
  ): InsuranceEligibilityResult => ({
    applicationFingerprint: input.applicationFingerprint,
    eligibilityStatus: 'eligible',
    evidenceReference: 'test-eligibility-evidence',
  });
  /** Supply bounded test PDF bytes for the stored private descriptor. */
  let documentFactory = (
    input: Parameters<PaymentDocumentRetrieval['retrieve']>[0],
  ): RetrievedPaymentDocument => ({
    paymentId: input.payment.id,
    documentId: input.document.documentId,
    providerDocumentReference: input.document.providerDocumentReference,
    contentType: 'application/pdf',
    bytes: Buffer.from('%PDF-1.7\nTest issued document'),
  });
  const verifyEducation = vi.fn(
    async (input: Parameters<EducationBeneficiaryVerification['verify']>[0]) =>
      educationFactory(input),
  );
  const verifyEligibility = vi.fn(
    async (input: Parameters<InsuranceEligibility['verify']>[0]) =>
      eligibilityFactory(input),
  );
  const retrieve = vi.fn(
    async (input: Parameters<PaymentDocumentRetrieval['retrieve']>[0]) =>
      documentFactory(input),
  );
  /** Authenticate only test name enquiries, preserving exact bank/account/currency correlation. */
  let bankVerificationFactory = (
    input: Parameters<BankBeneficiaryVerification['verify']>[0],
  ): BankBeneficiaryResult => ({
    productId: input.product.id,
    bankId: input.bank.id,
    accountNumber: input.accountNumber,
    currency: input.bank.currency,
    verificationStatus: 'verified',
    accountName: 'Test Bank Recipient',
    evidenceReference: `test-bank:${input.product.id}`,
  });
  const verifyBankBeneficiary = vi.fn(
    async (input: Parameters<BankBeneficiaryVerification['verify']>[0]) =>
      bankVerificationFactory(input),
  );
  registrations[providerKey] = {
    adapter:
      serviceType === 'airtime'
        ? new AirtimeProcessor({
            providerKey,
            /** Keep integration fixtures on the test protocol while exercising our real submission pipeline. */
            toRequest: (payment: ServicePayment) => payment,
            execute: submit,
            /** Fixture observations are independently controlled by each recovery scenario. */
            toSubmission: (result: ProviderPaymentResult) => result,
            lookup,
          })
        : { submit, lookup },
    bankBeneficiaryVerification: { verify: verifyBankBeneficiary },
    accountVerification: { verify },
    educationVerification: { verify: verifyEducation },
    insuranceEligibility: { verify: verifyEligibility },
    documentRetrieval: { retrieve },
    partnerAccountId,
    feeAccountId,
  };
  const headers = { authorization: `Bearer ${session.accessToken}` };
  return {
    session,
    wallet,
    productId,
    providerKey,
    networkCode,
    billerCode,
    bankId,
    bankCode,
    verifyBankBeneficiary,
    /** Set independently authenticated name-enquiry observations; no public request accepts verified names. */
    setBankVerification(factory: typeof bankVerificationFactory) {
      bankVerificationFactory = factory;
    },
    /** Verify the exact receiving bank account without reserving or transferring money. */
    bankValidation(overrides: Record<string, unknown> = {}) {
      return application.inject({
        method: 'POST',
        url: '/v1/bank-transfers/beneficiary-validations',
        headers,
        payload: { productId, accountNumber: '0012345678', ...overrides },
      });
    },
    /** Review a bank-specific quote using only server-owned verification and prices. */
    transferQuote(
      validationId: string,
      overrides: Record<string, unknown> = {},
    ) {
      return application.inject({
        method: 'POST',
        url: '/v1/bank-transfers/quotes',
        headers,
        payload: {
          productId,
          walletId: wallet.id,
          bankBeneficiaryValidationId: validationId,
          amountMinorUnits: '10000',
          ...overrides,
        },
      });
    },
    /** Submit a reviewed bank transfer under its original logical identity. */
    transfer(
      quoteId: string,
      requestKey = randomUUID(),
      overrides: Record<string, unknown> = {},
    ) {
      return application.inject({
        method: 'POST',
        url: '/v1/bank-transfers',
        headers,
        payload: { quoteId, requestKey, ...overrides },
      });
    },
    /** Recover the original accepted bank transfer without another external submission. */
    reconcileTransfer(transferId: string) {
      return application.inject({
        method: 'POST',
        url: `/v1/bank-transfers/${transferId}/reconcile`,
        headers,
      });
    },
    partnerAccountId,
    feeAccountId,
    submit,
    lookup,
    headers,
    verify,
    verifyEducation,
    verifyEligibility,
    retrieve,
    insuranceTerms,
    /** Set independently authenticated beneficiary evidence. */
    setEducationVerification(factory: typeof educationFactory) {
      educationFactory = factory;
    },
    /** Set independently authenticated eligibility evidence. */
    setEligibility(factory: typeof eligibilityFactory) {
      eligibilityFactory = factory;
    },
    /** Set test-only authenticated document bytes and correlation. */
    setDocument(factory: typeof documentFactory) {
      documentFactory = factory;
    },
    /** Verify a beneficiary through the real authenticated HTTP boundary. */
    educationValidation(overrides: Record<string, unknown> = {}) {
      return application.inject({
        method: 'POST',
        url: '/v1/payments/education-validations',
        headers,
        payload: {
          productId,
          beneficiaryIdentifier: '00123456789',
          ...overrides,
        },
      });
    },
    /** Consent to immutable product terms and request eligibility without initiating a purchase. */
    insuranceApplication(overrides: Record<string, unknown> = {}) {
      return application.inject({
        method: 'POST',
        url: '/v1/payments/insurance-applications',
        headers,
        payload: {
          productId,
          insuredProfile: {
            fullName: 'Test Insured',
            identityNumber: '00123456789',
            dateOfBirth: '1990-01-01',
          },
          termsVersion: insuranceTerms.version,
          acceptedTerms: true,
          coverageStartsOn: currentTime.toISOString().slice(0, 10),
          ...overrides,
        },
      });
    },
    /** Control independently authenticated recipient observations in bill validation scenarios. */
    setVerification(
      factory: (input: {
        product: ServiceProduct;
        accountNumber: string;
      }) => BillAccountVerificationResult,
    ) {
      verificationFactory = factory;
    },
    /** Verify a decoder/customer/meter identifier through the real HTTP boundary without initiating a purchase. */
    verifyAccount(overrides: Record<string, unknown> = {}) {
      return application.inject({
        method: 'POST',
        url: '/v1/payments/account-validations',
        headers,
        payload: { productId, accountNumber: '00123456789', ...overrides },
      });
    },
    /** Change only trusted adapter evidence; no public endpoint accepts settlement claims. */
    setResult(factory: (payment: ServicePayment) => ProviderPaymentResult) {
      resultFactory = factory;
    },
    /** Obtain authoritative owner balances using the same wallet service as purchase orchestration. */
    balance() {
      return wallets.getWalletBalance({
        actorId: session.account.id,
        walletId: wallet.id,
      });
    },
    /** Request review terms via the actual validation and authentication boundary. */
    quote(overrides: Record<string, unknown> = {}) {
      return application.inject({
        method: 'POST',
        url: '/v1/payments/quotes',
        headers,
        payload: {
          walletId: wallet.id,
          productId,
          ...(isMobile ? { recipientPhoneNumber: '+2348012345678' } : {}),
          ...(hasFixedPrice ? {} : { amountMinorUnits: '10000' }),
          ...overrides,
        },
      });
    },
    /** Submit explicit consent, permitting hostile overrides for validation scenarios. */
    pay(
      quoteId: string,
      requestKey = randomUUID(),
      overrides: Record<string, unknown> = {},
    ) {
      return application.inject({
        method: 'POST',
        url: '/v1/payments',
        headers,
        payload: { quoteId, requestKey, ...overrides },
      });
    },
    /** Look up/recover only the existing payment. */
    reconcile(paymentId: string) {
      return application.inject({
        method: 'POST',
        url: `/v1/payments/${paymentId}/reconcile`,
        headers,
      });
    },
  };
}

/** Test-only authenticated customer details, preserving the selected product/biller/meter and exact leading-zero identifier. */
function verifiedBillAccount(input: {
  product: ServiceProduct;
  accountNumber: string;
}): BillAccountVerificationResult {
  return {
    productId: input.product.id,
    accountNumber: input.accountNumber,
    billerCode: input.product.billerCode!,
    electricityMeterType: input.product.electricityMeterType,
    verificationStatus: 'verified',
    customerName: 'Test Household',
    serviceAddress:
      input.product.serviceType === 'electricity'
        ? 'Test service address'
        : null,
    evidenceReference: `test-validation:${input.product.id}`,
  };
}

/** Test-only prepaid receipt with an ordered token and exact optional kWh decimal. */
function prepaidReceipt(): PaymentFulfilment {
  return {
    fulfilmentType: 'electricity_prepaid',
    receiptReference: 'prepaid-test-receipt',
    tokens: [{ label: 'Recharge token', value: '0001 2345 6789 0123 4567' }],
    unitsKilowattHours: '12.375',
  };
}

/** Generate a correlated unresolved adapter observation; provider submission is deliberately not delivery confirmation. */
function pending(payment: ServicePayment): ProviderPaymentResult {
  return {
    paymentId: payment.id,
    termsFingerprint: paymentTermsFingerprint(payment),
    outcome: 'pending',
  };
}

/** Generate test-only correlated fulfilment evidence for the exact submitted identity and terms. */
function succeeded(
  payment: ServicePayment,
): Extract<ProviderPaymentResult, { outcome: 'succeeded' }> {
  return {
    ...pending(payment),
    outcome: 'succeeded',
    providerTransactionReference: `movement:${payment.id}`,
    evidenceReference: `receipt:${payment.id}`,
  };
}

/** Generate test-only rejection evidence; only independently safe outcomes can return held funds. */
function failed(
  payment: ServicePayment,
  fundsSafeToRelease = true,
): Extract<ProviderPaymentResult, { outcome: 'failed' }> {
  return {
    ...pending(payment),
    outcome: 'failed',
    providerTransactionReference: `movement:${payment.id}`,
    evidenceReference: `receipt:${payment.id}`,
    fundsSafeToRelease,
  };
}

describe('first-party service payments', () => {
  it.each([
    ['GET', '/v1/service-catalog/products'],
    ['POST', '/v1/payments/quotes'],
    ['POST', '/v1/payments'],
    ['POST', '/v1/payments/account-validations'],
    ['GET', `/v1/payments/account-validations/${randomUUID()}`],
    ['GET', `/v1/payments/${randomUUID()}`],
    ['POST', `/v1/payments/${randomUUID()}/reconcile`],
  ] as const)('requires a session on %s %s', async (method, url) => {
    const response = await application.inject({ method, url });
    expect(response.statusCode).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().code).toBe('INVALID_CREDENTIALS');
  });

  it('lists filtered products with bounded keyset pagination and no provider or ledger details', async () => {
    const context = await fixture('data');
    await database.administrator
      .insertInto('service_catalog_products')
      .columns([
        'id',
        'service_type',
        'network_code',
        'display_name',
        'currency',
        'fixed_price_minor_units',
        'minimum_amount_minor_units',
        'maximum_amount_minor_units',
        'amount_step_minor_units',
        'fee_minor_units',
        'allowance_label',
        'validity_seconds',
        'quote_lifetime_seconds',
        'provider_key',
        'provider_product_code',
        'is_enabled',
      ])
      .expression(
        database.administrator
          .selectFrom('service_catalog_products')
          .select([
            sql<string>`${randomUUID()}::uuid`.as('id'),
            'service_type',
            'network_code',
            'display_name',
            'currency',
            'fixed_price_minor_units',
            'minimum_amount_minor_units',
            'maximum_amount_minor_units',
            'amount_step_minor_units',
            'fee_minor_units',
            'allowance_label',
            'validity_seconds',
            'quote_lifetime_seconds',
            'provider_key',
            'provider_product_code',
            'is_enabled',
          ])
          .where('id', '=', context.productId),
      )
      .execute();
    const response = await application.inject({
      method: 'GET',
      url: `/v1/service-catalog/products?networkCode=${context.networkCode}&serviceType=data&limit=1`,
      headers: context.headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().products).toHaveLength(1);
    expect(response.json().nextCursor).toEqual(expect.any(String));
    expect(response.json().products[0]).toMatchObject({
      fixedPriceMinorUnits: '12500',
      allowanceLabel: '1 GB',
      validitySeconds: 86_400,
      isSubmissionAvailable: true,
    });
    expect(response.json().products[0]).not.toHaveProperty('providerKey');
    expect(response.json().products[0]).not.toHaveProperty(
      'providerProductCode',
    );
    const next = await application.inject({
      method: 'GET',
      url: `/v1/service-catalog/products?networkCode=${context.networkCode}&limit=1&afterId=${response.json().nextCursor}`,
      headers: context.headers,
    });
    expect(next.json().nextCursor).toBeNull();
    expect(next.json().products[0].id).not.toBe(response.json().products[0].id);
  });

  it.each(['airtime', 'data'] as const)(
    'prices %s on the server, preserving exact review terms without moving money',
    async (serviceType) => {
      const context = await fixture(serviceType);
      const response = await context.quote();
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        currency: 'NGN',
        serviceType,
        feeMinorUnits: '50',
        principalMinorUnits: serviceType === 'airtime' ? '10000' : '12500',
        totalDebitMinorUnits: serviceType === 'airtime' ? '10050' : '12550',
        isSubmissionAvailable: true,
        recipientPhoneNumber: '+2348012345678',
      });
      expect(response.json()).not.toHaveProperty('ownerId');
      expect(response.json()).not.toHaveProperty('providerKey');
      expect(context.submit).not.toHaveBeenCalled();
      expect((await context.balance()).reservedMinorUnits).toBe(0n);
    },
  );

  it('rejects inexact amounts, forged terms/identities and malformed recipients before a payment is created', async () => {
    const context = await fixture();
    for (const overrides of [
      ...[
        10000,
        '0',
        '-100',
        '1.5',
        '1e4',
        '010000',
        '10000\n',
        '9999999999999999999',
        null,
      ].map((amountMinorUnits) => ({ amountMinorUnits })),
      { actorId: randomUUID() },
      { feeMinorUnits: '0' },
      { currency: 'USD' },
      { totalDebitMinorUnits: '1' },
      { recipientPhoneNumber: '08012345678' },
      { recipientPhoneNumber: '+2348012345678\n' },
    ]) {
      const response = await context.quote(overrides);
      expect(response.statusCode).toBe(400);
    }
    const quote = (await context.quote()).json<PaymentQuoteResponseDto>();
    for (const overrides of [
      { requestKey: ' padded' },
      { requestKey: 'key\n' },
      { actorId: randomUUID() },
      { amountMinorUnits: '1' },
      { outcome: 'succeeded' },
    ]) {
      expect(
        (await context.pay(quote.id, randomUUID(), overrides)).statusCode,
      ).toBe(400);
    }
    expect((await context.balance()).availableMinorUnits).toBe(100_000n);
    const data = await fixture('data');
    expect((await data.quote({ amountMinorUnits: '1' })).statusCode).toBe(400);
    expect((await data.quote({ amountMinorUnits: null })).statusCode).toBe(400);
  });

  it('fails closed before holding funds when a product has no registered adapter', async () => {
    const context = await fixture();
    delete registrations[context.providerKey];
    const quote = (await context.quote()).json<PaymentQuoteResponseDto>();
    expect(quote.isSubmissionAvailable).toBe(false);
    expect((await context.pay(quote.id)).statusCode).toBe(503);
    expect((await context.balance()).reservedMinorUnits).toBe(0n);
    expect(
      await database.database
        .selectFrom('service_payments')
        .select('id')
        .where('quote_id', '=', quote.id)
        .execute(),
    ).toHaveLength(0);
  });

  it('rejects expired/withdrawn quotes and prevents another owner from pricing, reading or spending an owned wallet', async () => {
    const context = await fixture();
    const stranger = await fixture();
    expect(
      (await stranger.quote({ walletId: context.wallet.id })).statusCode,
    ).toBe(404);
    const quote = (await context.quote()).json<PaymentQuoteResponseDto>();
    expect((await stranger.pay(quote.id)).statusCode).toBe(404);
    expect(
      (
        await application.inject({
          method: 'GET',
          url: `/v1/payments/quotes/${quote.id}`,
          headers: stranger.headers,
        })
      ).statusCode,
    ).toBe(404);
    currentTime = new Date(new Date(quote.expiresAt).getTime());
    expect((await context.pay(quote.id)).json().code).toBe('QUOTE_EXPIRED');
    const fresh = (await context.quote()).json<PaymentQuoteResponseDto>();
    await database.administrator
      .updateTable('service_catalog_products')
      .set({ is_enabled: false })
      .where('id', '=', context.productId)
      .execute();
    expect((await context.pay(fresh.id)).json().code).toBe(
      'PRODUCT_UNAVAILABLE',
    );
    expect((await context.quote()).statusCode).toBe(404);
    expect((await context.balance()).reservedMinorUnits).toBe(0n);
  });

  it.each(['airtime', 'data'] as const)(
    'deduplicates concurrent %s submissions and captures once after correlated fulfilment',
    async (serviceType) => {
      const context = await fixture(serviceType);
      context.setResult(succeeded);
      const quote = (await context.quote()).json<PaymentQuoteResponseDto>();
      const requestKey = randomUUID();
      const responses = await Promise.all(
        Array.from({ length: 6 }, () => context.pay(quote.id, requestKey)),
      );
      expect(responses.every((response) => response.statusCode === 200)).toBe(
        true,
      );
      expect(
        new Set(responses.map((response) => response.json().id)).size,
      ).toBe(1);
      expect(context.submit).toHaveBeenCalledTimes(1);
      const paymentId = responses[0]!.json().id as string;
      expect((await context.reconcile(paymentId)).json().paymentStatus).toBe(
        'succeeded',
      );
      expect((await context.balance()).reservedMinorUnits).toBe(0n);
      expect((await context.balance()).availableMinorUnits).toBe(
        100_000n - BigInt(quote.totalDebitMinorUnits),
      );
      expect(
        await database.database
          .selectFrom('wallet_reservations')
          .selectAll()
          .where('payment_reference', '=', paymentId)
          .execute(),
      ).toHaveLength(1);
      currentTime = new Date(currentTime.getTime() + 600_000);
      expect(
        (await context.pay(quote.id, requestKey)).json().paymentStatus,
      ).toBe('succeeded');
      expect(context.submit).toHaveBeenCalledTimes(1);
      const fresh = (await context.quote()).json<PaymentQuoteResponseDto>();
      expect((await context.pay(fresh.id, requestKey)).json().code).toBe(
        'PAYMENT_CONFLICT',
      );
      expect((await context.pay(quote.id, randomUUID())).json().code).toBe(
        'PAYMENT_CONFLICT',
      );
      const stranger = await fixture();
      expect(
        (
          await application.inject({
            method: 'GET',
            url: `/v1/payments/${paymentId}`,
            headers: stranger.headers,
          })
        ).statusCode,
      ).toBe(404);
      expect((await stranger.reconcile(paymentId)).statusCode).toBe(404);
    },
  );

  it('does not spend the same funds for competing payments and never dispatches the insufficient request', async () => {
    const context = await fixture('airtime', 10_050n);
    const quote1 = (await context.quote()).json<PaymentQuoteResponseDto>();
    const quote2 = (await context.quote()).json<PaymentQuoteResponseDto>();
    const responses = await Promise.all([
      context.pay(quote1.id),
      context.pay(quote2.id),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 409,
    ]);
    expect(context.submit).toHaveBeenCalledTimes(1);
    expect((await context.balance()).availableMinorUnits).toBe(0n);
    expect((await context.balance()).reservedMinorUnits).toBe(10_050n);
  });

  it('retains an unresolved hold after a provider timeout; retries and reconciliation never buy again', async () => {
    const context = await fixture();
    context.submit.mockRejectedValueOnce(
      new Error('uncertain upstream timeout'),
    );
    const quote = (await context.quote()).json<PaymentQuoteResponseDto>();
    const requestKey = randomUUID();
    expect((await context.pay(quote.id, requestKey)).statusCode).toBe(503);
    const retry = await context.pay(quote.id, requestKey);
    expect(retry.json().paymentStatus).toBe('pending');
    const paymentId = retry.json().id as string;
    expect((await context.balance()).reservedMinorUnits).toBe(10_050n);
    currentTime = new Date(currentTime.getTime() + 600_000);
    context.setResult(succeeded);
    expect((await context.reconcile(paymentId)).json().paymentStatus).toBe(
      'succeeded',
    );
    expect(context.submit).toHaveBeenCalledTimes(1);
    expect(context.lookup).toHaveBeenCalledTimes(1);
    expect((await context.balance()).reservedMinorUnits).toBe(0n);
  });

  it('releases only independently safe failure evidence and preserves the same instruction on retries', async () => {
    const context = await fixture();
    context.setResult((payment) => failed(payment, false));
    const quote = (await context.quote()).json<PaymentQuoteResponseDto>();
    const requestKey = randomUUID();
    const response = await context.pay(quote.id, requestKey);
    expect(response.json().paymentStatus).toBe('pending');
    expect((await context.balance()).reservedMinorUnits).toBe(10_050n);
    context.setResult((payment) => failed(payment));
    expect(
      (await context.reconcile(response.json().id)).json().paymentStatus,
    ).toBe('failed');
    expect((await context.pay(quote.id, requestKey)).json().paymentStatus).toBe(
      'failed',
    );
    expect((await context.balance()).availableMinorUnits).toBe(100_000n);
    expect(context.submit).toHaveBeenCalledTimes(1);
  });

  it.each(['airtime', 'data'] as const)(
    'rejects mismatched %s evidence without capturing or releasing a reservation',
    async (serviceType) => {
      const context = await fixture(serviceType);
      context.setResult((payment) => ({
        ...succeeded(payment),
        paymentId: randomUUID(),
      }));
      const quote = (await context.quote()).json<PaymentQuoteResponseDto>();
      const requestKey = randomUUID();
      const rejected = await context.pay(quote.id, requestKey);
      expect(rejected.statusCode).toBe(503);
      expect(rejected.json()).toMatchObject({
        code: 'PAYMENT_UNAVAILABLE',
        message: 'The provider result refers to a different payment.',
      });
      const retry = await context.pay(quote.id, requestKey);
      context.setResult((payment) => ({
        ...succeeded(payment),
        termsFingerprint: 'different recipient/amount',
      }));
      const reconciliation = await context.reconcile(retry.json().id);
      expect(reconciliation.statusCode).toBe(503);
      expect(reconciliation.json()).toMatchObject({
        code: 'PAYMENT_UNAVAILABLE',
        message:
          'The provider result does not match the accepted payment terms.',
      });
      expect((await context.balance()).reservedMinorUnits).toBe(
        BigInt(quote.totalDebitMinorUnits),
      );
      expect((await context.balance()).availableMinorUnits).toBe(
        100_000n - BigInt(quote.totalDebitMinorUnits),
      );
      expect(context.submit).toHaveBeenCalledTimes(1);
      expect(context.lookup).toHaveBeenCalledTimes(1);
      expect(
        await database.database
          .selectFrom('service_payment_outcomes')
          .selectAll()
          .where('payment_id', '=', retry.json().id)
          .execute(),
      ).toHaveLength(0);
    },
  );

  it('recovers a crash after reservation commit without reserving or dispatching twice', async () => {
    const context = await fixture();
    const execution = application.get(PaymentExecutionService);
    const quote = (await context.quote()).json<PaymentQuoteResponseDto>();
    const requestKey = randomUUID();
    const payment = await execution.accept({
      actorId: context.session.account.id,
      quoteId: quote.id,
      requestKey,
    });
    await wallets.reserveWalletFunds({
      actorId: context.session.account.id,
      walletId: context.wallet.id,
      requestKey: `payment:${payment.id}`,
      paymentReference: payment.id,
      value: money(BigInt(quote.totalDebitMinorUnits), 'NGN'),
    });
    const recovered = await context.pay(quote.id, requestKey);
    expect(recovered.json()).toMatchObject({
      id: payment.id,
      paymentStatus: 'pending',
    });
    expect(context.submit).toHaveBeenCalledTimes(1);
    expect((await context.balance()).reservedMinorUnits).toBe(10_050n);
  });

  it('recovers stored fulfilment evidence after a ledger outage even when the adapter is later removed', async () => {
    const context = await fixture();
    context.setResult(succeeded);
    const settlement = vi
      .spyOn(wallets, 'settleWalletReservation')
      .mockRejectedValueOnce(new Error('ledger temporarily unavailable'));
    const quote = (await context.quote()).json<PaymentQuoteResponseDto>();
    const requestKey = randomUUID();
    expect((await context.pay(quote.id, requestKey)).statusCode).toBe(503);
    delete registrations[context.providerKey];
    const recovered = await context.pay(quote.id, requestKey);
    expect(recovered.json().paymentStatus).toBe('succeeded');
    expect(context.submit).toHaveBeenCalledTimes(1);
    expect(context.lookup).not.toHaveBeenCalled();
    expect((await context.balance()).reservedMinorUnits).toBe(0n);
    settlement.mockRestore();
  });

  it('rechecks quote expiry at the wallet transaction boundary before holding money', async () => {
    const context = await fixture();
    const quote = (await context.quote()).json<PaymentQuoteResponseDto>();
    const originalReserve = wallets.reserveWalletFunds.bind(wallets);
    const reserve = vi
      .spyOn(wallets, 'reserveWalletFunds')
      .mockImplementationOnce((input) => {
        // Model scheduling/lock delay after initial quote validation but before financial mutation.
        currentTime = new Date(quote.expiresAt);
        return originalReserve(input);
      });
    const response = await context.pay(quote.id);
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('QUOTE_EXPIRED');
    expect((await context.balance()).reservedMinorUnits).toBe(0n);
    expect((await context.balance()).availableMinorUnits).toBe(100_000n);
    expect(context.submit).not.toHaveBeenCalled();
    reserve.mockRestore();
  });

  it('recovers an owned logical key after a lost response even if the adapter is no longer registered', async () => {
    const context = await fixture();
    const quote = (await context.quote()).json<PaymentQuoteResponseDto>();
    const requestKey = randomUUID();
    const submitted = await context.pay(quote.id, requestKey);
    delete registrations[context.providerKey];
    const recovered = await application.inject({
      method: 'GET',
      url: `/v1/payments/by-request-key?requestKey=${requestKey}`,
      headers: context.headers,
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toEqual(submitted.json());
    expect(context.submit).toHaveBeenCalledTimes(1);
    const stranger = await fixture();
    expect(
      (
        await application.inject({
          method: 'GET',
          url: `/v1/payments/by-request-key?requestKey=${requestKey}`,
          headers: stranger.headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await application.inject({
          method: 'GET',
          url: '/v1/payments/by-request-key',
          headers: context.headers,
        })
      ).statusCode,
    ).toBe(400);
  });

  it('preserves exact review and settlement amounts beyond JavaScript safe integer precision', async () => {
    const amountMinorUnits = 9_007_199_254_741_000n;
    const context = await fixture(
      'airtime',
      amountMinorUnits + 50n,
      amountMinorUnits,
    );
    context.setResult(succeeded);
    const quote = (
      await context.quote({ amountMinorUnits: amountMinorUnits.toString() })
    ).json<PaymentQuoteResponseDto>();
    expect(quote.principalMinorUnits).toBe('9007199254741000');
    expect(quote.totalDebitMinorUnits).toBe('9007199254741050');
    expect((await context.pay(quote.id)).json().paymentStatus).toBe(
      'succeeded',
    );
    expect((await context.balance()).availableMinorUnits).toBe(0n);
    expect((await context.balance()).reservedMinorUnits).toBe(0n);
  });

  it('does not use one upstream economic movement to settle two different first-party payments', async () => {
    const context = await fixture();
    context.setResult((payment) => ({
      ...succeeded(payment),
      providerTransactionReference: 'duplicate-test-movement',
    }));
    const quote1 = (await context.quote()).json<PaymentQuoteResponseDto>();
    const quote2 = (await context.quote()).json<PaymentQuoteResponseDto>();
    expect((await context.pay(quote1.id)).json().paymentStatus).toBe(
      'succeeded',
    );
    const requestKey = randomUUID();
    expect((await context.pay(quote2.id, requestKey)).statusCode).toBe(503);
    expect(
      (await context.pay(quote2.id, requestKey)).json().paymentStatus,
    ).toBe('pending');
    expect((await context.balance()).reservedMinorUnits).toBe(10_050n);
  });

  it('prevents new spending from frozen wallets while allowing already-held obligations to settle', async () => {
    const context = await fixture();
    const quote = (await context.quote()).json<PaymentQuoteResponseDto>();
    const payment = await context.pay(quote.id);
    const waitingQuote = (
      await context.quote()
    ).json<PaymentQuoteResponseDto>();
    await database.administrator
      .updateTable('wallets')
      .set({ wallet_status: 'frozen' })
      .where('id', '=', context.wallet.id)
      .execute();
    expect((await context.pay(waitingQuote.id)).json().code).toBe(
      'WALLET_RESTRICTED',
    );
    context.setResult(succeeded);
    expect(
      (await context.reconcile(payment.json().id)).json().paymentStatus,
    ).toBe('succeeded');
    expect(context.submit).toHaveBeenCalledTimes(1);
  });

  it.each(['tv', 'electricity'] as const)(
    'requires validated %s accounts and binds authoritative review prices to the exact recipient',
    async (serviceType) => {
      const context = await fixture(serviceType);
      const validated = await context.verifyAccount();
      expect(validated.statusCode).toBe(201);
      const account = validated.json<BillAccountValidationResponseDto>();
      expect(account).toMatchObject({
        accountNumber: '00123456789',
        customerName: 'Test Household',
        billerCode: context.billerCode,
      });
      expect(account).not.toHaveProperty('ownerId');
      expect(account).not.toHaveProperty('evidenceReference');
      expect((await context.balance()).reservedMinorUnits).toBe(0n);
      expect(context.submit).not.toHaveBeenCalled();
      const response = await context.quote({ accountValidationId: account.id });
      expect(response.statusCode).toBe(201);
      const quote = response.json<PaymentQuoteResponseDto>();
      expect(quote).toMatchObject({
        serviceType,
        recipientPhoneNumber: null,
        networkCode: null,
        billerCode: context.billerCode,
        accountValidation: account,
        principalMinorUnits: serviceType === 'tv' ? '12500' : '10000',
      });
      expect(quote.expiresAt).toBe(account.expiresAt);
      expect((await context.quote()).statusCode).toBe(400);
      expect(
        (
          await context.quote({
            accountValidationId: account.id,
            accountNumber: 'another-meter',
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await context.quote({
            accountValidationId: account.id,
            recipientPhoneNumber: '+2348012345678',
          })
        ).statusCode,
      ).toBe(400);
      if (serviceType === 'tv') {
        expect(
          (
            await context.quote({
              accountValidationId: account.id,
              amountMinorUnits: '1',
            })
          ).statusCode,
        ).toBe(400);
      }
    },
  );

  it('fails closed on absent, invalid, pending, timed-out or mismatched recipient verification without saving a false verified account', async () => {
    const context = await fixture('electricity');
    context.setVerification((input) => ({
      ...verifiedBillAccount(input),
      verificationStatus: 'invalid',
    }));
    expect((await context.verifyAccount()).json().code).toBe('ACCOUNT_INVALID');
    context.setVerification((input) => ({
      ...verifiedBillAccount(input),
      verificationStatus: 'pending',
    }));
    expect((await context.verifyAccount()).json().code).toBe(
      'ACCOUNT_UNCONFIRMED',
    );
    context.verify.mockRejectedValueOnce(new Error('verification timeout'));
    expect((await context.verifyAccount()).statusCode).toBe(503);
    context.setVerification((input) => ({
      ...verifiedBillAccount(input),
      electricityMeterType: 'postpaid',
    }));
    expect((await context.verifyAccount()).statusCode).toBe(503);
    registrations[context.providerKey] = {
      ...registrations[context.providerKey]!,
      accountVerification: undefined,
    };
    expect((await context.verifyAccount()).statusCode).toBe(503);
    const product = await application.inject({
      method: 'GET',
      url: `/v1/service-catalog/products/${context.productId}`,
      headers: context.headers,
    });
    expect(product.json().isSubmissionAvailable).toBe(false);
    expect(
      await database.database
        .selectFrom('service_bill_account_validations')
        .select('id')
        .where('product_id', '=', context.productId)
        .execute(),
    ).toHaveLength(0);
    expect((await context.balance()).reservedMinorUnits).toBe(0n);
  });

  it('rejects forged validation fields, numeric/padded identifiers and another owner/product’s validation', async () => {
    const context = await fixture('tv');
    const stranger = await fixture('tv');
    for (const overrides of [
      { accountNumber: 123456 },
      { accountNumber: null },
      { accountNumber: ' 001234' },
      { customerName: 'Injected' },
      { verificationStatus: 'verified' },
      { actorId: randomUUID() },
      { electricityMeterType: 'prepaid' },
    ]) {
      expect((await context.verifyAccount(overrides)).statusCode).toBe(400);
    }
    const account = (
      await context.verifyAccount()
    ).json<BillAccountValidationResponseDto>();
    expect(
      (await stranger.quote({ accountValidationId: account.id })).statusCode,
    ).toBe(404);
    expect(
      (
        await application.inject({
          method: 'GET',
          url: `/v1/payments/account-validations/${account.id}`,
          headers: stranger.headers,
        })
      ).statusCode,
    ).toBe(404);
    const ownOtherAccount = (
      await context.verifyAccount({ productId: stranger.productId })
    ).json<BillAccountValidationResponseDto>();
    expect(
      (await context.quote({ accountValidationId: ownOtherAccount.id }))
        .statusCode,
    ).toBe(400);
  });

  it('requires fresh verification for new quotes and prevents expired validation from opening a new wallet hold', async () => {
    const context = await fixture('electricity');
    const account = (
      await context.verifyAccount()
    ).json<BillAccountValidationResponseDto>();
    const quote = (
      await context.quote({ accountValidationId: account.id })
    ).json<PaymentQuoteResponseDto>();
    currentTime = new Date(account.expiresAt);
    expect(
      (await context.quote({ accountValidationId: account.id })).json().code,
    ).toBe('ACCOUNT_VALIDATION_EXPIRED');
    expect((await context.pay(quote.id)).json().code).toBe('QUOTE_EXPIRED');
    expect((await context.balance()).reservedMinorUnits).toBe(0n);
    const receipt = await application.inject({
      method: 'GET',
      url: `/v1/payments/account-validations/${account.id}`,
      headers: context.headers,
    });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json().expiresAt).toBe(account.expiresAt);
  });

  it.each(['tv', 'electricity'] as const)(
    'deduplicates concurrent %s submissions and settles a matching fulfilment once',
    async (serviceType) => {
      const context = await fixture(serviceType);
      const fulfilment: PaymentFulfilment =
        serviceType === 'tv'
          ? {
              fulfilmentType: 'tv_subscription',
              activationReference: 'tv-test-activation',
              renewalAt: '2030-02-01T00:00:00.000Z',
            }
          : prepaidReceipt();
      context.setResult((payment) => ({
        ...succeeded(payment),
        outcome: 'succeeded',
        fulfilment,
      }));
      const account = (
        await context.verifyAccount()
      ).json<BillAccountValidationResponseDto>();
      const quote = (
        await context.quote({ accountValidationId: account.id })
      ).json<PaymentQuoteResponseDto>();
      const requestKey = randomUUID();
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => context.pay(quote.id, requestKey)),
      );
      expect(responses.every((response) => response.statusCode === 200)).toBe(
        true,
      );
      const paymentId = responses[0]!.json().id as string;
      const recovered = await context.reconcile(paymentId);
      expect(recovered.json()).toMatchObject({
        id: paymentId,
        paymentStatus: 'succeeded',
        fulfilmentStatus: 'available',
        fulfilment,
      });
      expect(context.submit).toHaveBeenCalledTimes(1);
      expect(context.lookup).not.toHaveBeenCalled();
      expect((await context.balance()).reservedMinorUnits).toBe(0n);
      expect((await context.balance()).availableMinorUnits).toBe(
        100_000n - BigInt(quote.totalDebitMinorUnits),
      );
    },
  );

  it('keeps prepaid payment success distinct from a delayed token and retrieves it without buying or capturing twice', async () => {
    const context = await fixture('electricity');
    context.setResult(succeeded);
    const account = (
      await context.verifyAccount()
    ).json<BillAccountValidationResponseDto>();
    const quote = (
      await context.quote({ accountValidationId: account.id })
    ).json<PaymentQuoteResponseDto>();
    const requestKey = randomUUID();
    const payment = await context.pay(quote.id, requestKey);
    expect(payment.json()).toMatchObject({
      paymentStatus: 'succeeded',
      fulfilmentStatus: 'pending',
      fulfilment: null,
    });
    context.setResult(pending);
    expect(
      (await context.reconcile(payment.json().id)).json().paymentStatus,
    ).toBe('succeeded');
    context.lookup.mockRejectedValueOnce(new Error('receipt lookup timeout'));
    expect((await context.reconcile(payment.json().id)).statusCode).toBe(503);
    expect((await context.pay(quote.id, requestKey)).json().paymentStatus).toBe(
      'succeeded',
    );
    currentTime = new Date(currentTime.getTime() + 600_000);
    context.setResult((instruction) => ({
      ...succeeded(instruction),
      outcome: 'succeeded',
      fulfilment: prepaidReceipt(),
    }));
    const recovered = await context.reconcile(payment.json().id);
    expect(recovered.json()).toMatchObject({
      paymentStatus: 'succeeded',
      fulfilmentStatus: 'available',
      fulfilment: prepaidReceipt(),
    });
    expect(context.submit).toHaveBeenCalledTimes(1);
    expect((await context.balance()).availableMinorUnits).toBe(89_950n);
    delete registrations[context.providerKey];
    expect(
      (await context.reconcile(payment.json().id)).json().fulfilment,
    ).toEqual(prepaidReceipt());
  });

  it('returns postpaid references without prepaid tokens and filters catalogue products by the selected biller/meter mode', async () => {
    const context = await fixture('electricity', 100_000n, 90_000n, 'postpaid');
    const fulfilment: PaymentFulfilment = {
      fulfilmentType: 'electricity_postpaid',
      receiptReference: 'postpaid-test-reference',
    };
    context.setResult((payment) => ({
      ...succeeded(payment),
      outcome: 'succeeded',
      fulfilment,
    }));
    const catalogue = await application.inject({
      method: 'GET',
      url: `/v1/service-catalog/products?serviceType=electricity&billerCode=${context.billerCode}&electricityMeterType=postpaid`,
      headers: context.headers,
    });
    expect(catalogue.json().products).toHaveLength(1);
    expect(catalogue.json().products[0]).toMatchObject({
      networkCode: null,
      billerCode: context.billerCode,
      electricityMeterType: 'postpaid',
    });
    const account = (
      await context.verifyAccount()
    ).json<BillAccountValidationResponseDto>();
    const quote = (
      await context.quote({ accountValidationId: account.id })
    ).json<PaymentQuoteResponseDto>();
    const payment = await context.pay(quote.id);
    expect(payment.json()).toMatchObject({
      paymentStatus: 'succeeded',
      fulfilmentStatus: 'available',
      fulfilment,
    });
    expect(payment.json().fulfilment).not.toHaveProperty('tokens');
  });

  it('rejects wrong-mode or malformed fulfilment while preserving independently confirmed payment success', async () => {
    const context = await fixture('electricity');
    context.setResult(succeeded);
    const account = (
      await context.verifyAccount()
    ).json<BillAccountValidationResponseDto>();
    const quote = (
      await context.quote({ accountValidationId: account.id })
    ).json<PaymentQuoteResponseDto>();
    const payment = await context.pay(quote.id);
    const wrongMode: PaymentFulfilment = {
      fulfilmentType: 'electricity_postpaid',
      receiptReference: 'wrong-mode',
    };
    context.setResult((instruction) => ({
      ...succeeded(instruction),
      outcome: 'succeeded',
      fulfilment: wrongMode,
    }));
    expect((await context.reconcile(payment.json().id)).statusCode).toBe(503);
    context.setResult((instruction) => ({
      ...succeeded(instruction),
      outcome: 'succeeded',
      fulfilment: {
        fulfilmentType: 'electricity_prepaid',
        receiptReference: 'bad-token',
        tokens: [],
        unitsKilowattHours: null,
      },
    }));
    expect((await context.reconcile(payment.json().id)).statusCode).toBe(503);
    expect(
      (await context.pay(quote.id, payment.json().requestKey)).json(),
    ).toMatchObject({
      paymentStatus: 'succeeded',
      fulfilmentStatus: 'pending',
      fulfilment: null,
    });
    expect(context.submit).toHaveBeenCalledTimes(1);
    expect((await context.balance()).reservedMinorUnits).toBe(0n);
  });

  it('preserves bill uncertainty and releases money only for a correlated independently safe failure', async () => {
    const context = await fixture('tv');
    const account = (
      await context.verifyAccount()
    ).json<BillAccountValidationResponseDto>();
    const quote = (
      await context.quote({ accountValidationId: account.id })
    ).json<PaymentQuoteResponseDto>();
    context.submit.mockRejectedValueOnce(new Error('TV fulfilment timeout'));
    const requestKey = randomUUID();
    expect((await context.pay(quote.id, requestKey)).statusCode).toBe(503);
    const payment = await context.pay(quote.id, requestKey);
    context.setResult((instruction) => failed(instruction, false));
    expect(
      (await context.reconcile(payment.json().id)).json().paymentStatus,
    ).toBe('pending');
    context.setResult((instruction) => failed(instruction, true));
    expect((await context.reconcile(payment.json().id)).json()).toMatchObject({
      paymentStatus: 'failed',
      fulfilmentStatus: 'not_available',
      fulfilment: null,
    });
    expect((await context.balance()).availableMinorUnits).toBe(100_000n);
    expect(context.submit).toHaveBeenCalledTimes(1);
  });

  it('settles stored bill confirmation after a ledger outage before attempting unavailable token retrieval', async () => {
    const context = await fixture('electricity');
    context.setResult(succeeded);
    const account = (
      await context.verifyAccount()
    ).json<BillAccountValidationResponseDto>();
    const quote = (
      await context.quote({ accountValidationId: account.id })
    ).json<PaymentQuoteResponseDto>();
    const settlement = vi
      .spyOn(wallets, 'settleWalletReservation')
      .mockRejectedValueOnce(new Error('test ledger outage'));
    const requestKey = randomUUID();
    expect((await context.pay(quote.id, requestKey)).statusCode).toBe(503);
    const progress = await application.inject({
      method: 'GET',
      url: `/v1/payments/by-request-key?requestKey=${requestKey}`,
      headers: context.headers,
    });
    expect(progress.json().paymentStatus).toBe('pending');
    delete registrations[context.providerKey];
    expect((await context.reconcile(progress.json().id)).statusCode).toBe(503);
    const committed = await context.pay(quote.id, requestKey);
    expect(committed.json()).toMatchObject({
      paymentStatus: 'succeeded',
      fulfilmentStatus: 'pending',
      fulfilment: null,
    });
    expect((await context.balance()).reservedMinorUnits).toBe(0n);
    expect((await context.balance()).availableMinorUnits).toBe(89_950n);
    expect(context.submit).toHaveBeenCalledTimes(1);
    settlement.mockRestore();
  });

  it('keeps stored bill tokens immutable and isolates competing receipt observations', async () => {
    const context = await fixture('electricity');
    context.setResult(succeeded);
    const account = (
      await context.verifyAccount()
    ).json<BillAccountValidationResponseDto>();
    const quote = (
      await context.quote({ accountValidationId: account.id })
    ).json<PaymentQuoteResponseDto>();
    const payment = await context.pay(quote.id);
    context.setResult((instruction) => ({
      ...succeeded(instruction),
      fulfilment: prepaidReceipt(),
    }));
    const recovered = await Promise.all(
      Array.from({ length: 4 }, () => context.reconcile(payment.json().id)),
    );
    expect(recovered.every((response) => response.statusCode === 200)).toBe(
      true,
    );
    expect(recovered[0]!.json().fulfilment).toEqual(prepaidReceipt());
    expect(
      await database.database
        .selectFrom('service_payment_fulfilments')
        .select('payment_id')
        .where('payment_id', '=', payment.json().id)
        .execute(),
    ).toHaveLength(1);
    await expect(
      database.administrator
        .updateTable('service_payment_fulfilments')
        .set({
          fulfilment: sql`'{"fulfilmentType":"electricity_postpaid"}'::jsonb`,
        })
        .where('payment_id', '=', payment.json().id)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
    expect(context.submit).toHaveBeenCalledTimes(1);
    expect((await context.balance()).availableMinorUnits).toBe(89_950n);
  });

  it('protects quote/product/payment history and rejects dispatch without held funds under the runtime role', async () => {
    const context = await fixture();
    const quote = (await context.quote()).json<PaymentQuoteResponseDto>();
    await expect(
      database.administrator
        .updateTable('service_catalog_products')
        .set({ fee_minor_units: 0n })
        .where('id', '=', context.productId)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database.administrator
        .updateTable('service_payment_quotes')
        .set({ principal_minor_units: 1n })
        .where('id', '=', quote.id)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
    const payment = await application.get(PaymentExecutionService).accept({
      actorId: context.session.account.id,
      quoteId: quote.id,
      requestKey: randomUUID(),
    });
    await expect(
      database.database
        .updateTable('service_payments')
        .set({ submission_started_at: new Date() })
        .where('id', '=', payment.id)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database.database
        .updateTable('service_catalog_products')
        .set({ is_enabled: false })
        .where('id', '=', context.productId)
        .execute(),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

/** Test-only policy evidence matches the complete consented application; payment evidence alone contains no policy. */
function issuedPolicy(payment: ServicePayment): PaymentFulfilment {
  const application = payment.quote.insuranceApplication!;
  return {
    fulfilmentType: 'insurance_policy',
    policyNumber: '000-policy-123',
    insuredName: application.insuredProfile.fullName,
    coverageStartsOn: application.coverageStartsOn,
    coverageEndsOn: application.coverageEndsOn,
  };
}

/** Test-only immutable private descriptor; the first-party response must project out its upstream reference. */
function policyDocument(): PaymentDocument {
  return {
    documentId: 'policy',
    documentType: 'policy',
    displayName: 'Issued policy',
    contentType: 'application/pdf',
    providerDocumentReference: 'private-policy-reference',
  };
}

/** Prepare a fresh owner/product-bound education or insurance quote through the real HTTP contract. */
async function preparedQuote(
  context: Awaited<ReturnType<typeof fixture>>,
  serviceType: 'education' | 'insurance',
) {
  const preparation =
    serviceType === 'education'
      ? await context.educationValidation()
      : await context.insuranceApplication();
  expect(preparation.statusCode).toBe(201);
  const selector =
    serviceType === 'education'
      ? { educationValidationId: preparation.json().id }
      : { insuranceApplicationId: preparation.json().id };
  const quote = await context.quote(selector);
  expect(quote.statusCode).toBe(201);
  return {
    preparation,
    selector,
    quote: quote.json<PaymentQuoteResponseDto>(),
  };
}

describe('education and individual insurance payments', () => {
  it.each(['education-validations', 'insurance-applications'] as const)(
    'requires authentication for %s preparation and recovery',
    async (route) => {
      for (const [method, url] of [
        ['POST', `/v1/payments/${route}`],
        ['GET', `/v1/payments/${route}/${randomUUID()}`],
      ] as const) {
        const response = await application.inject({ method, url });
        expect(response.statusCode).toBe(401);
        expect(response.headers['cache-control']).toBe('no-store');
      }
    },
  );

  it.each(['education', 'insurance'] as const)(
    'publishes %s first-party terms but cannot verify or spend with no adapter',
    async (serviceType) => {
      const context = await fixture(serviceType);
      delete registrations[context.providerKey];
      const product = await application.inject({
        method: 'GET',
        url: `/v1/service-catalog/products/${context.productId}`,
        headers: context.headers,
      });
      expect(product.statusCode).toBe(200);
      expect(product.json().serviceType).toBe(serviceType);
      expect(product.json().isSubmissionAvailable).toBe(false);
      expect(product.json()).not.toHaveProperty('providerKey');
      const preparation =
        serviceType === 'education'
          ? await context.educationValidation()
          : await context.insuranceApplication();
      expect(preparation.statusCode).toBe(503);
      expect((await context.balance()).availableMinorUnits).toBe(100_000n);
      expect((await context.balance()).reservedMinorUnits).toBe(0n);
    },
  );

  it('verifies education beneficiary and purpose without funds movement and preserves leading zeros', async () => {
    const context = await fixture('education');
    const { preparation, quote } = await preparedQuote(context, 'education');
    expect(preparation.json()).toMatchObject({
      beneficiaryIdentifier: '00123456789',
      beneficiaryName: 'Test Student',
      purpose: 'Test education purpose',
      paymentType: 'institution_fee',
    });
    expect(preparation.json()).not.toHaveProperty('evidenceReference');
    expect(quote.educationValidation?.beneficiaryIdentifier).toBe(
      '00123456789',
    );
    expect(quote.principalMinorUnits).toBe('10000');
    expect(quote.expiresAt).toBe(preparation.json().expiresAt);
    expect(context.submit).not.toHaveBeenCalled();
    expect((await context.balance()).availableMinorUnits).toBe(100_000n);
    const recovered = await application.inject({
      method: 'GET',
      url: `/v1/payments/education-validations/${preparation.json().id}`,
      headers: context.headers,
    });
    expect(recovered.json()).toEqual(preparation.json());
  });

  it.each(['invalid', 'pending', 'mismatch'] as const)(
    'rejects %s education verification without creating evidence or holding money',
    async (mode) => {
      const context = await fixture('education');
      context.setEducationVerification((input) => ({
        productId: mode === 'mismatch' ? randomUUID() : input.product.id,
        institutionCode: input.product.billerCode!,
        beneficiaryIdentifier: input.beneficiaryIdentifier,
        verificationStatus: mode === 'invalid' ? 'invalid' : 'pending',
      }));
      const response = await context.educationValidation();
      expect(response.statusCode).toBe(mode === 'invalid' ? 400 : 503);
      const expectedCode = {
        invalid: 'EDUCATION_BENEFICIARY_INVALID',
        pending: 'EDUCATION_BENEFICIARY_UNCONFIRMED',
        mismatch: 'INVALID_PROVIDER_EVIDENCE',
      };
      expect(response.json().code).toBe(expectedCode[mode]);
      expect(
        await database.database
          .selectFrom('service_education_validations')
          .select('id')
          .where('product_id', '=', context.productId)
          .execute(),
      ).toHaveLength(0);
      expect((await context.balance()).reservedMinorUnits).toBe(0n);
    },
  );

  it.each(['education', 'insurance'] as const)(
    'isolates %s preparation by owner/product and rejects cross-service selectors',
    async (serviceType) => {
      const context = await fixture(serviceType);
      const { preparation, selector } = await preparedQuote(
        context,
        serviceType,
      );
      const other = await fixture(serviceType);
      expect((await other.quote({ ...selector })).statusCode).toBe(404);
      expect(
        (await context.quote({ ...selector, productId: other.productId }))
          .statusCode,
      ).toBe(400);
      expect(
        (
          await context.quote({
            ...selector,
            recipientPhoneNumber: '+2348012345678',
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await context.quote({
            ...selector,
            accountValidationId: randomUUID(),
          })
        ).statusCode,
      ).toBe(400);
      const route =
        serviceType === 'education'
          ? 'education-validations'
          : 'insurance-applications';
      expect(
        (
          await application.inject({
            method: 'GET',
            url: `/v1/payments/${route}/${preparation.json().id}`,
            headers: other.headers,
          })
        ).statusCode,
      ).toBe(404);
    },
  );

  it.each(['education', 'insurance'] as const)(
    'refuses expired %s evidence and rechecks its bound expiry before a wallet hold',
    async (serviceType) => {
      const context = await fixture(serviceType);
      const { quote, selector } = await preparedQuote(context, serviceType);
      const originalReserve = wallets.reserveWalletFunds.bind(wallets);
      const reserve = vi
        .spyOn(wallets, 'reserveWalletFunds')
        .mockImplementationOnce((input) => {
          currentTime = new Date(quote.expiresAt);
          return originalReserve(input);
        });
      try {
        expect((await context.pay(quote.id)).json().code).toBe('QUOTE_EXPIRED');
        const stale = await context.quote(selector);
        expect(stale.statusCode).toBe(409);
        expect(stale.json().code).toBe(
          serviceType === 'education'
            ? 'EDUCATION_VALIDATION_EXPIRED'
            : 'INSURANCE_APPLICATION_EXPIRED',
        );
        expect((await context.balance()).reservedMinorUnits).toBe(0n);
        expect(context.submit).not.toHaveBeenCalled();
      } finally {
        reserve.mockRestore();
      }
    },
  );

  it.each(['education', 'insurance'] as const)(
    'deduplicates concurrent %s payments and stores matching proof with one capture',
    async (serviceType) => {
      const context = await fixture(serviceType);
      context.setResult((payment) => ({
        ...succeeded(payment),
        fulfilment:
          serviceType === 'education'
            ? {
                fulfilmentType: 'education_fee',
                institutionReference: '000-institution-reference',
              }
            : issuedPolicy(payment),
        ...(serviceType === 'insurance'
          ? { documents: [policyDocument()] }
          : {}),
      }));
      const { quote } = await preparedQuote(context, serviceType);
      const requestKey = randomUUID();
      const results = await Promise.all(
        Array.from({ length: 5 }, () => context.pay(quote.id, requestKey)),
      );
      expect(results.every((response) => response.statusCode === 200)).toBe(
        true,
      );
      expect(new Set(results.map((response) => response.json().id)).size).toBe(
        1,
      );
      const final = await context.reconcile(results[0]!.json().id);
      expect(final.json()).toMatchObject({
        paymentStatus: 'succeeded',
        fulfilmentStatus: 'available',
        policyIssuanceStatus:
          serviceType === 'insurance' ? 'issued' : 'not_applicable',
      });
      expect(context.submit).toHaveBeenCalledTimes(1);
      expect((await context.balance()).availableMinorUnits).toBe(
        serviceType === 'education' ? 89_950n : 87_450n,
      );
      expect((await context.balance()).reservedMinorUnits).toBe(0n);
    },
  );

  it('prices education vouchers from the catalogue and recovers delayed exact voucher/serial strings without repurchasing', async () => {
    const context = await fixture(
      'education',
      100_000n,
      90_000n,
      'prepaid',
      'voucher',
    );
    const { quote, selector } = await preparedQuote(context, 'education');
    expect(quote.principalMinorUnits).toBe('12500');
    expect(
      (await context.quote({ ...selector, amountMinorUnits: '10000' }))
        .statusCode,
    ).toBe(400);
    context.setResult(succeeded);
    const paid = await context.pay(quote.id);
    expect(paid.json()).toMatchObject({
      paymentStatus: 'succeeded',
      fulfilmentStatus: 'pending',
      fulfilment: null,
    });
    context.setResult((payment) => ({
      ...succeeded(payment),
      fulfilment: {
        fulfilmentType: 'education_voucher',
        voucherCode: '000123456789',
        serialNumber: '000987654321',
      },
    }));
    const recovered = await context.reconcile(paid.json().id);
    expect(recovered.json().fulfilment).toEqual({
      fulfilmentType: 'education_voucher',
      voucherCode: '000123456789',
      serialNumber: '000987654321',
    });
    expect(context.submit).toHaveBeenCalledTimes(1);
    expect((await context.balance()).availableMinorUnits).toBe(87_450n);
  });

  it('records explicit reviewed insurance terms, minimizes insured fields and derives exact calendar period', async () => {
    const context = await fixture('insurance');
    const { preparation, quote } = await preparedQuote(context, 'insurance');
    expect(preparation.json()).toMatchObject({
      acceptedTerms: true,
      eligibilityStatus: 'eligible',
      termsVersion: 'terms-1',
      insuredProfile: { identityNumber: '00123456789' },
    });
    expect(preparation.json()).not.toHaveProperty('evidenceReference');
    expect(
      new Date(preparation.json().coverageEndsOn).getTime() -
        new Date(preparation.json().coverageStartsOn).getTime(),
    ).toBe(365 * 86_400_000);
    expect(quote.insuranceTerms).toEqual(context.insuranceTerms);
    expect(quote.principalMinorUnits).toBe('12500');
    expect(context.submit).not.toHaveBeenCalled();
  });

  it.each([
    { acceptedTerms: false },
    { acceptedTerms: 'true' },
    { acceptedTerms: null },
    { termsVersion: 'old-version' },
    { insuredProfile: { fullName: 'Test Insured' } },
    { insuredProfile: { fullName: 'Test Insured', identityNumber: 123 } },
    {
      insuredProfile: {
        fullName: 'Test Insured',
        identityNumber: '00123',
        phoneNumber: '+2348012345678',
      },
    },
    {
      insuredProfile: {
        fullName: 'Test Insured',
        identityNumber: '00123',
        arbitrary: 'field',
      },
    },
    { insuredProfile: null },
    { insuredProfile: [] },
    {
      insuredProfile: {
        fullName: 'Test Insured',
        identityNumber: '00123',
        dateOfBirth: '2025-02-30',
      },
    },
    { coverageStartsOn: '2030-02-30' },
    { coverageStartsOn: '2000-01-01' },
    { coverageEndsOn: '2031-01-01' },
    { premiumMinorUnits: '1' },
  ])(
    'rejects invalid consent/insured/calendar or financial overrides before eligibility I/O: %j',
    async (overrides) => {
      const context = await fixture('insurance');
      const response = await context.insuranceApplication(overrides);
      expect([400, 409]).toContain(response.statusCode);
      expect(context.verifyEligibility).not.toHaveBeenCalled();
      expect((await context.balance()).reservedMinorUnits).toBe(0n);
    },
  );

  it.each(['ineligible', 'pending', 'mismatch'] as const)(
    'does not store %s insurance eligibility as an approved application',
    async (mode) => {
      const context = await fixture('insurance');
      context.setEligibility((input) => ({
        applicationFingerprint:
          mode === 'mismatch' ? 'wrong-profile' : input.applicationFingerprint,
        eligibilityStatus: mode === 'ineligible' ? 'ineligible' : 'pending',
      }));
      const response = await context.insuranceApplication();
      expect(response.statusCode).toBe(mode === 'ineligible' ? 400 : 503);
      expect(
        await database.database
          .selectFrom('service_insurance_applications')
          .select('id')
          .where('product_id', '=', context.productId)
          .execute(),
      ).toHaveLength(0);
      expect(context.submit).not.toHaveBeenCalled();
    },
  );

  it('rejects fixed-premium overrides and prevents one insurance application purchasing two policies through different quotes', async () => {
    const context = await fixture('insurance');
    const { quote, selector } = await preparedQuote(context, 'insurance');
    expect(
      (await context.quote({ ...selector, amountMinorUnits: '1' })).statusCode,
    ).toBe(400);
    const otherQuote = await context.quote(selector);
    expect(otherQuote.statusCode).toBe(201);
    const results = await Promise.all([
      context.pay(quote.id),
      context.pay(otherQuote.json().id),
    ]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([
      200, 409,
    ]);
    expect(context.submit).toHaveBeenCalledTimes(1);
    expect((await context.balance()).reservedMinorUnits).toBe(12_550n);
  });

  it('keeps insurance payment, policy issuance and document availability distinct through delayed retrieval', async () => {
    const context = await fixture('insurance');
    const { quote } = await preparedQuote(context, 'insurance');
    context.setResult(succeeded);
    const paid = await context.pay(quote.id);
    expect(paid.json()).toMatchObject({
      paymentStatus: 'succeeded',
      policyIssuanceStatus: 'awaiting_issuance',
      fulfilment: null,
      documentStatus: 'pending',
      documents: [],
    });
    context.setResult((payment) => ({
      ...succeeded(payment),
      fulfilment: issuedPolicy(payment),
    }));
    const issued = await context.reconcile(paid.json().id);
    expect(issued.json()).toMatchObject({
      paymentStatus: 'succeeded',
      policyIssuanceStatus: 'issued',
      documentStatus: 'pending',
      documents: [],
    });
    context.setResult((payment) => ({
      ...succeeded(payment),
      fulfilment: issuedPolicy(payment),
      documents: [policyDocument()],
    }));
    const recovered = await Promise.all(
      Array.from({ length: 3 }, () => context.reconcile(paid.json().id)),
    );
    expect(recovered.every((response) => response.statusCode === 200)).toBe(
      true,
    );
    expect(recovered[0]!.json()).toMatchObject({
      policyIssuanceStatus: 'issued',
      documentStatus: 'available',
      documents: [{ documentId: 'policy' }],
    });
    expect(recovered[0]!.body).not.toContain('private-policy-reference');
    expect(recovered[0]!.body).not.toContain('isCoverageActive');
    expect(context.submit).toHaveBeenCalledTimes(1);
    expect((await context.balance()).availableMinorUnits).toBe(87_450n);
    expect((await context.balance()).reservedMinorUnits).toBe(0n);
    expect(
      await database.database
        .selectFrom('service_payment_documents')
        .select('document_id')
        .where('payment_id', '=', paid.json().id)
        .execute(),
    ).toHaveLength(1);
  });

  it.each(['insuredName', 'coverageStartsOn', 'coverageEndsOn'] as const)(
    'rejects policy issuance with a mismatched %s while preserving confirmed financial progress',
    async (field) => {
      const context = await fixture('insurance');
      const { quote } = await preparedQuote(context, 'insurance');
      context.setResult((payment) => ({
        ...succeeded(payment),
        fulfilment: {
          ...issuedPolicy(payment),
          [field]: 'wrong-value',
        } as PaymentFulfilment,
      }));
      const paid = await context.pay(quote.id);
      expect(paid.statusCode).toBe(503);
      context.setResult(succeeded);
      const payment = await database.database
        .selectFrom('service_payments')
        .select('id')
        .where('quote_id', '=', quote.id)
        .executeTakeFirstOrThrow();
      const recovered = await context.reconcile(payment.id);
      expect(recovered.json()).toMatchObject({
        paymentStatus: 'succeeded',
        policyIssuanceStatus: 'awaiting_issuance',
        fulfilment: null,
      });
      expect((await context.balance()).availableMinorUnits).toBe(87_450n);
      expect(context.submit).toHaveBeenCalledTimes(1);
    },
  );

  it('requires policy issuance before storing insurance documents and preserves financial evidence after malformed metadata', async () => {
    const context = await fixture('insurance');
    const { quote } = await preparedQuote(context, 'insurance');
    context.setResult((payment) => ({
      ...succeeded(payment),
      documents: [policyDocument()],
    }));
    expect((await context.pay(quote.id)).statusCode).toBe(503);
    const payment = await database.database
      .selectFrom('service_payments')
      .select('id')
      .where('quote_id', '=', quote.id)
      .executeTakeFirstOrThrow();
    context.setResult(succeeded);
    expect(
      (await context.reconcile(payment.id)).json().policyIssuanceStatus,
    ).toBe('awaiting_issuance');
    expect(
      await database.database
        .selectFrom('service_payment_documents')
        .select('document_id')
        .where('payment_id', '=', payment.id)
        .execute(),
    ).toHaveLength(0);
    expect(context.submit).toHaveBeenCalledTimes(1);
  });

  it('authorizes PDF retrieval before external I/O and keeps private references, filenames and responses bounded', async () => {
    const context = await fixture('insurance');
    const { quote } = await preparedQuote(context, 'insurance');
    context.setResult((payment) => ({
      ...succeeded(payment),
      fulfilment: issuedPolicy(payment),
      documents: [policyDocument()],
    }));
    const paid = await context.pay(quote.id);
    const url = paid.json().documents[0].downloadPath;
    const other = await fixture();
    expect((await application.inject({ method: 'GET', url })).statusCode).toBe(
      401,
    );
    expect(
      (await application.inject({ method: 'GET', url, headers: other.headers }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await application.inject({
          method: 'GET',
          url: url.replace('/policy', '/missing'),
          headers: context.headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(context.retrieve).not.toHaveBeenCalled();
    const response = await application.inject({
      method: 'GET',
      url,
      headers: context.headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-disposition']).toContain(
      `${paid.json().id}-policy.pdf`,
    );
    expect(response.headers).not.toHaveProperty('location');
    expect(response.body).toContain('%PDF-');
    expect(context.retrieve).toHaveBeenCalledTimes(1);
    expect(context.submit).toHaveBeenCalledTimes(1);
  });

  it.each([
    'payment',
    'document',
    'reference',
    'media',
    'magic',
    'size',
    'outage',
  ] as const)(
    'rejects invalid/unavailable %s document retrieval without affecting paid/issued progress',
    async (mode) => {
      const context = await fixture('insurance');
      const { quote } = await preparedQuote(context, 'insurance');
      context.setResult((payment) => ({
        ...succeeded(payment),
        fulfilment: issuedPolicy(payment),
        documents: [policyDocument()],
      }));
      const paid = await context.pay(quote.id);
      context.setDocument((input) => ({
        paymentId: mode === 'payment' ? randomUUID() : input.payment.id,
        documentId: mode === 'document' ? 'other' : input.document.documentId,
        providerDocumentReference:
          mode === 'reference'
            ? 'other'
            : input.document.providerDocumentReference,
        contentType: (mode === 'media'
          ? 'text/html'
          : 'application/pdf') as 'application/pdf',
        bytes:
          mode === 'size'
            ? new Uint8Array(10 * 1024 * 1024 + 1)
            : Buffer.from(mode === 'magic' ? '<html>bad' : '%PDF-1.7\nissued'),
      }));
      if (mode === 'outage') {
        context.retrieve.mockRejectedValueOnce(new Error('Document timeout'));
      }
      const response = await application.inject({
        method: 'GET',
        url: paid.json().documents[0].downloadPath,
        headers: context.headers,
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe('DOCUMENT_UNAVAILABLE');
      const recovered = await context.reconcile(paid.json().id);
      expect(recovered.json()).toMatchObject({
        paymentStatus: 'succeeded',
        policyIssuanceStatus: 'issued',
        documentStatus: 'available',
      });
      expect(context.submit).toHaveBeenCalledTimes(1);
      expect((await context.balance()).availableMinorUnits).toBe(87_450n);
    },
  );

  it('recovers a confirmed premium after a ledger outage even when no policy or adapter is available', async () => {
    const context = await fixture('insurance');
    const { quote } = await preparedQuote(context, 'insurance');
    context.setResult(succeeded);
    const settlement = vi
      .spyOn(wallets, 'settleWalletReservation')
      .mockRejectedValueOnce(new Error('Ledger outage'));
    try {
      expect((await context.pay(quote.id)).statusCode).toBe(503);
      const payment = await database.database
        .selectFrom('service_payments')
        .select('id')
        .where('quote_id', '=', quote.id)
        .executeTakeFirstOrThrow();
      delete registrations[context.providerKey];
      expect((await context.reconcile(payment.id)).statusCode).toBe(503);
      const stored = await application.inject({
        method: 'GET',
        url: `/v1/payments/${payment.id}`,
        headers: context.headers,
      });
      expect(stored.json()).toMatchObject({
        paymentStatus: 'succeeded',
        policyIssuanceStatus: 'awaiting_issuance',
        documents: [],
      });
      expect((await context.balance()).availableMinorUnits).toBe(87_450n);
      expect((await context.balance()).reservedMinorUnits).toBe(0n);
      expect(context.submit).toHaveBeenCalledTimes(1);
      expect(context.lookup).not.toHaveBeenCalled();
    } finally {
      settlement.mockRestore();
    }
  });

  it('protects immutable consent, beneficiary and document history against overwrites', async () => {
    const context = await fixture('insurance');
    const { quote, preparation } = await preparedQuote(context, 'insurance');
    context.setResult((payment) => ({
      ...succeeded(payment),
      fulfilment: issuedPolicy(payment),
      documents: [policyDocument()],
    }));
    const paid = await context.pay(quote.id);
    await expect(
      database.administrator
        .updateTable('service_insurance_applications')
        .set({ accepted_terms: false })
        .where('id', '=', preparation.json().id)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database.administrator
        .updateTable('service_payment_documents')
        .set({ provider_document_reference: 'other' })
        .where('payment_id', '=', paid.json().id)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database.administrator
        .updateTable('service_catalog_products')
        .set({ insurance_terms: sql`'{}'::jsonb` })
        .where('id', '=', context.productId)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
    const education = await fixture('education');
    const beneficiary = await education.educationValidation();
    await expect(
      database.administrator
        .updateTable('service_education_validations')
        .set({ beneficiary_identifier: 'other' })
        .where('id', '=', beneficiary.json().id)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
    expect((await context.balance()).availableMinorUnits).toBe(87_450n);
  });
});

describe('education and insurance proof recovery boundaries', () => {
  it('treats an authenticated education fee PDF as supported proof and downloads it without repeating payment', async () => {
    const context = await fixture('education');
    const { quote } = await preparedQuote(context, 'education');
    context.setResult((payment) => ({
      ...succeeded(payment),
      documents: [
        {
          ...policyDocument(),
          documentId: 'receipt',
          documentType: 'education_receipt',
        },
      ],
    }));
    const paid = await context.pay(quote.id);
    expect(paid.statusCode).toBe(200);
    expect(paid.json()).toMatchObject({
      paymentStatus: 'succeeded',
      fulfilmentStatus: 'available',
      fulfilment: null,
      documentStatus: 'available',
    });
    expect(
      (
        await application.inject({
          method: 'GET',
          url: paid.json().documents[0].downloadPath,
          headers: context.headers,
        })
      ).statusCode,
    ).toBe(200);
    expect((await context.reconcile(paid.json().id)).statusCode).toBe(200);
    expect(context.lookup).not.toHaveBeenCalled();
    expect(context.submit).toHaveBeenCalledTimes(1);
    expect((await context.balance()).availableMinorUnits).toBe(89_950n);
  });

  it('does not accept education vouchers for institution fees or overwrite independently confirmed payment progress', async () => {
    const context = await fixture('education');
    const { quote } = await preparedQuote(context, 'education');
    context.setResult((payment) => ({
      ...succeeded(payment),
      fulfilment: {
        fulfilmentType: 'education_voucher',
        voucherCode: '000123',
        serialNumber: null,
      },
    }));
    expect((await context.pay(quote.id)).statusCode).toBe(503);
    context.setResult(succeeded);
    const payment = await database.database
      .selectFrom('service_payments')
      .select('id')
      .where('quote_id', '=', quote.id)
      .executeTakeFirstOrThrow();
    expect((await context.reconcile(payment.id)).json()).toMatchObject({
      paymentStatus: 'succeeded',
      fulfilmentStatus: 'pending',
      fulfilment: null,
    });
    expect(context.submit).toHaveBeenCalledTimes(1);
    expect((await context.balance()).availableMinorUnits).toBe(89_950n);
  });

  it('rejects spending if the required insurance document capability is removed after quote review', async () => {
    const context = await fixture('insurance');
    const { quote } = await preparedQuote(context, 'insurance');
    registrations[context.providerKey] = {
      ...registrations[context.providerKey]!,
      documentRetrieval: undefined,
    };
    const reviewed = await application.inject({
      method: 'GET',
      url: `/v1/payments/quotes/${quote.id}`,
      headers: context.headers,
    });
    expect(reviewed.json().isSubmissionAvailable).toBe(false);
    expect((await context.pay(quote.id)).statusCode).toBe(503);
    expect((await context.balance()).reservedMinorUnits).toBe(0n);
    expect(context.submit).not.toHaveBeenCalled();
  });

  it('releases a safely rejected premium and reports no issued policy or pending documents', async () => {
    const context = await fixture('insurance');
    const { quote } = await preparedQuote(context, 'insurance');
    context.setResult((payment) => failed(payment));
    const response = await context.pay(quote.id);
    expect(response.json()).toMatchObject({
      paymentStatus: 'failed',
      policyIssuanceStatus: 'not_issued',
      documentStatus: 'not_available',
      documents: [],
    });
    expect((await context.balance()).availableMinorUnits).toBe(100_000n);
    expect((await context.balance()).reservedMinorUnits).toBe(0n);
  });

  it('refuses conflicting immutable document descriptors while recovering the already captured premium', async () => {
    const context = await fixture('insurance');
    const { quote } = await preparedQuote(context, 'insurance');
    context.setResult((payment) => ({
      ...succeeded(payment),
      fulfilment: issuedPolicy(payment),
      documents: [policyDocument()],
    }));
    const settlement = vi
      .spyOn(wallets, 'settleWalletReservation')
      .mockRejectedValueOnce(new Error('Ledger outage'));
    try {
      expect((await context.pay(quote.id)).statusCode).toBe(503);
      const stored = await database.database
        .selectFrom('service_payments')
        .select('id')
        .where('quote_id', '=', quote.id)
        .executeTakeFirstOrThrow();
      // Exercise append-only storage with competing authenticated descriptor observations; customer input cannot reach this contract.
      await expect(
        new PostgresPaymentRepository(database.database).recordDocuments(
          stored.id,
          [
            {
              ...policyDocument(),
              providerDocumentReference: 'conflicting-reference',
            },
          ],
        ),
      ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_EVIDENCE' });
      expect((await context.reconcile(stored.id)).statusCode).toBe(200);
      const document = await database.database
        .selectFrom('service_payment_documents')
        .select('provider_document_reference')
        .where('payment_id', '=', stored.id)
        .executeTakeFirstOrThrow();
      expect(document.provider_document_reference).toBe(
        'private-policy-reference',
      );
      expect((await context.balance()).availableMinorUnits).toBe(87_450n);
      expect(context.submit).toHaveBeenCalledTimes(1);
    } finally {
      settlement.mockRestore();
    }
  });
});

it('does not hold funds for an accepted unfunded insurance instruction after a required capability is removed', async () => {
  const context = await fixture('insurance', 0n);
  const { quote } = await preparedQuote(context, 'insurance');
  const requestKey = randomUUID();
  const unfunded = await context.pay(quote.id, requestKey);
  expect(unfunded.json().code).toBe('INSUFFICIENT_FUNDS');
  registrations[context.providerKey] = {
    ...registrations[context.providerKey]!,
    documentRetrieval: undefined,
  };
  const replay = await context.pay(quote.id, requestKey);
  expect(replay.statusCode).toBe(503);
  expect(replay.json().code).toBe('PAYMENT_UNAVAILABLE');
  expect((await context.balance()).reservedMinorUnits).toBe(0n);
  expect(context.submit).not.toHaveBeenCalled();
});

/** Test-only authenticated bank credit evidence binds exactly the accepted recipient and principal, independently of provider debit/acknowledgement. */
function bankCreditConfirmation(
  payment: ServicePayment,
): Extract<PaymentFulfilment, { fulfilmentType: 'bank_transfer' }> {
  const beneficiary = payment.quote.bankBeneficiaryValidation!;
  return {
    fulfilmentType: 'bank_transfer',
    transferReference: `bank-credit:${payment.id}`,
    creditedAt: currentTime.toISOString(),
    bankId: beneficiary.bankId,
    accountNumber: beneficiary.accountNumber,
    accountName: beneficiary.accountName,
    amountMinorUnits: payment.quote.principal.amountMinorUnits.toString(),
    currency: payment.quote.principal.currency,
  };
}

/** Obtain a real owner-scoped bank name enquiry and immutable quote; neither operation spends money. */
async function preparedBankTransfer(
  context: Awaited<ReturnType<typeof fixture>>,
  overrides: Record<string, unknown> = {},
) {
  const beneficiary = await context.bankValidation();
  expect(beneficiary.statusCode).toBe(201);
  const quote = await context.transferQuote(beneficiary.json().id, overrides);
  expect(quote.statusCode).toBe(201);
  return { beneficiary: beneficiary.json(), quote: quote.json() };
}

describe('first-party bank transfers', () => {
  it.each([
    ['GET', '/v1/bank-transfers/banks'],
    ['GET', `/v1/bank-transfers/banks/${randomUUID()}`],
    ['GET', '/v1/bank-transfers/products'],
    ['POST', '/v1/bank-transfers/beneficiary-validations'],
    ['GET', `/v1/bank-transfers/beneficiary-validations/${randomUUID()}`],
    ['POST', '/v1/bank-transfers/quotes'],
    ['GET', `/v1/bank-transfers/quotes/${randomUUID()}`],
    ['POST', '/v1/bank-transfers'],
    ['GET', '/v1/bank-transfers/by-request-key?requestKey=original'],
    ['GET', `/v1/bank-transfers/${randomUUID()}`],
    ['POST', `/v1/bank-transfers/${randomUUID()}/reconcile`],
  ] as const)('requires authentication on %s %s', async (method, url) => {
    const response = await application.inject({ method, url });
    expect(response.statusCode).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('discovers first-party banks and transfer-only prices with bounded currency/country/bank filters and stable pagination', async () => {
    const context = await fixture('bank_transfer');
    const next = await fixture('bank_transfer');
    const banks = await application.inject({
      method: 'GET',
      url: '/v1/bank-transfers/banks?currency=NGN&countryCode=NG&limit=1',
      headers: context.headers,
    });
    expect(banks.statusCode).toBe(200);
    expect(banks.json().banks).toHaveLength(1);
    const more = await application.inject({
      method: 'GET',
      url: `/v1/bank-transfers/banks?currency=NGN&countryCode=NG&limit=1&afterId=${banks.json().nextCursor}`,
      headers: context.headers,
    });
    expect(more.json().banks).toHaveLength(1);
    expect(more.json().banks[0].id).not.toBe(banks.json().banks[0].id);
    const product = await application.inject({
      method: 'GET',
      url: `/v1/bank-transfers/products?bankId=${context.bankId}&currency=NGN`,
      headers: context.headers,
    });
    expect(product.json().products).toEqual([
      expect.objectContaining({
        id: context.productId,
        bankId: context.bankId,
        feeMinorUnits: '50',
        isSubmissionAvailable: true,
      }),
    ]);
    expect(product.body).not.toContain(context.providerKey);
    const filtered = await application.inject({
      method: 'GET',
      url: `/v1/bank-transfers/products?bankId=${next.bankId}&currency=USD`,
      headers: context.headers,
    });
    expect(filtered.json().products).toEqual([]);
    expect(
      (
        await application.inject({
          method: 'GET',
          url: `/v1/bank-transfers/banks/${context.bankId}`,
          headers: context.headers,
        })
      ).json(),
    ).toMatchObject({
      bankCode: context.bankCode,
      minimumAccountNumberLength: 10,
      maximumAccountNumberLength: 10,
    });
  });

  it('publishes configured banks with unavailable submission and no fake name enquiries or wallet holds when adapters are absent', async () => {
    const context = await fixture('bank_transfer');
    delete registrations[context.providerKey];
    const products = await application.inject({
      method: 'GET',
      url: `/v1/bank-transfers/products?bankId=${context.bankId}`,
      headers: context.headers,
    });
    expect(products.json().products[0].isSubmissionAvailable).toBe(false);
    expect((await context.bankValidation()).statusCode).toBe(503);
    expect((await context.balance()).availableMinorUnits).toBe(100_000n);
    expect((await context.balance()).reservedMinorUnits).toBe(0n);
  });

  it('preserves verified account names, leading-zero identifiers, narration and exact amount/fee/debit review without spending', async () => {
    const context = await fixture('bank_transfer');
    const { beneficiary, quote } = await preparedBankTransfer(context, {
      narration: 'School fees for household',
    });
    expect(beneficiary).toMatchObject({
      bankId: context.bankId,
      bankName: 'Test Bank',
      accountNumber: '0012345678',
      accountName: 'Test Bank Recipient',
    });
    expect(beneficiary).not.toHaveProperty('evidenceReference');
    expect(quote).toMatchObject({
      amountMinorUnits: '10000',
      feeMinorUnits: '50',
      totalDebitMinorUnits: '10050',
      narration: 'School fees for household',
      beneficiary,
    });
    expect(quote.expiresAt).toBe(beneficiary.expiresAt);
    expect(context.submit).not.toHaveBeenCalled();
    expect((await context.balance()).availableMinorUnits).toBe(100_000n);
    const recovered = await application.inject({
      method: 'GET',
      url: `/v1/bank-transfers/beneficiary-validations/${beneficiary.id}`,
      headers: context.headers,
    });
    expect(recovered.json()).toEqual(beneficiary);
  });

  it.each([
    { accountNumber: 1234567890 },
    { accountNumber: null },
    { accountNumber: '123456789' },
    { accountNumber: '00123456789' },
    { accountNumber: '00123 5678' },
    { accountNumber: '0012345678\n' },
    { accountName: 'Caller invented name' },
    { ownerId: randomUUID() },
  ])(
    'rejects numeric conversion, wrong bank account rules and recipient/owner overrides before enquiry: %j',
    async (overrides) => {
      const context = await fixture('bank_transfer');
      expect((await context.bankValidation(overrides)).statusCode).toBe(400);
      expect(context.verifyBankBeneficiary).not.toHaveBeenCalled();
      expect((await context.balance()).reservedMinorUnits).toBe(0n);
    },
  );

  it.each([
    'invalid',
    'pending',
    'bank',
    'account',
    'product',
    'currency',
    'name',
  ] as const)(
    'rejects %s name enquiry without verified evidence or funds movement',
    async (mode) => {
      const context = await fixture('bank_transfer');
      context.setBankVerification((input) => ({
        productId: mode === 'product' ? randomUUID() : input.product.id,
        bankId: mode === 'bank' ? randomUUID() : input.bank.id,
        accountNumber: mode === 'account' ? '0012345679' : input.accountNumber,
        currency: mode === 'currency' ? 'USD' : input.bank.currency,
        verificationStatus:
          mode === 'invalid'
            ? 'invalid'
            : mode === 'pending'
              ? 'pending'
              : 'verified',
        accountName: mode === 'name' ? 'Bad\nName' : 'Test Bank Recipient',
        evidenceReference: 'private-name-enquiry',
      }));
      const response = await context.bankValidation();
      expect(response.statusCode).toBe(mode === 'invalid' ? 400 : 503);
      expect(
        await database.database
          .selectFrom('bank_transfer_beneficiary_validations')
          .select('id')
          .where('product_id', '=', context.productId)
          .execute(),
      ).toHaveLength(0);
      expect((await context.balance()).reservedMinorUnits).toBe(0n);
    },
  );

  it('isolates beneficiary/quotes by owner and product and rejects cross-service recipient selectors', async () => {
    const context = await fixture('bank_transfer');
    const { beneficiary, quote } = await preparedBankTransfer(context);
    const other = await fixture('bank_transfer');
    expect((await other.transferQuote(beneficiary.id)).statusCode).toBe(404);
    expect(
      (
        await context.transferQuote(beneficiary.id, {
          productId: other.productId,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await context.transferQuote(beneficiary.id, {
          walletId: other.wallet.id,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await context.quote({
          bankBeneficiaryValidationId: beneficiary.id,
          recipientPhoneNumber: '+2348012345678',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await context.quote({
          bankBeneficiaryValidationId: beneficiary.id,
          accountValidationId: randomUUID(),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await application.inject({
          method: 'GET',
          url: `/v1/bank-transfers/quotes/${quote.id}`,
          headers: other.headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await application.inject({
          method: 'GET',
          url: `/v1/bank-transfers/beneficiary-validations/${beneficiary.id}`,
          headers: other.headers,
        })
      ).statusCode,
    ).toBe(404);
  });

  it.each([
    { amountMinorUnits: '0' },
    { amountMinorUnits: '101' },
    { amountMinorUnits: '100000' },
    { amountMinorUnits: 10000 },
    { amountMinorUnits: '9223372036854775808' },
    { feeMinorUnits: '0' },
    { totalDebitMinorUnits: '1' },
    { accountNumber: '0012345679' },
    { narration: '' },
    { narration: 'Bad\nNarration' },
    { narration: null },
  ])(
    'rejects invalid limits/money, pricing and recipient overrides before spending: %j',
    async (overrides) => {
      const context = await fixture('bank_transfer');
      const validation = await context.bankValidation();
      expect(
        (await context.transferQuote(validation.json().id, overrides))
          .statusCode,
      ).toBe(400);
      expect(context.submit).not.toHaveBeenCalled();
      expect((await context.balance()).availableMinorUnits).toBe(100_000n);
    },
  );

  it('requires matching wallet currency and current verified-recipient expiry under wallet locks', async () => {
    const context = await fixture('bank_transfer');
    const { beneficiary, quote } = await preparedBankTransfer(context);
    const foreignWallet = await wallets.createWallet({
      actorId: context.session.account.id,
      currency: 'USD',
    });
    expect(
      (
        await context.transferQuote(beneficiary.id, {
          walletId: foreignWallet.id,
        })
      ).json().code,
    ).toBe('CURRENCY_MISMATCH');
    const originalReserve = wallets.reserveWalletFunds.bind(wallets);
    const reserve = vi
      .spyOn(wallets, 'reserveWalletFunds')
      .mockImplementationOnce((input) => {
        currentTime = new Date(quote.expiresAt);
        return originalReserve(input);
      });
    try {
      expect((await context.transfer(quote.id)).json().code).toBe(
        'QUOTE_EXPIRED',
      );
      expect((await context.transferQuote(beneficiary.id)).json().code).toBe(
        'BANK_BENEFICIARY_EXPIRED',
      );
      expect((await context.balance()).reservedMinorUnits).toBe(0n);
      expect(context.submit).not.toHaveBeenCalled();
    } finally {
      reserve.mockRestore();
    }
  });

  it('deduplicates competing submissions across bank and shared payment endpoints and captures once after confirmed recipient credit', async () => {
    const context = await fixture('bank_transfer');
    const { quote } = await preparedBankTransfer(context);
    context.setResult((payment) => ({
      ...succeeded(payment),
      fulfilment: bankCreditConfirmation(payment),
    }));
    const key = randomUUID();
    const results = await Promise.all([
      context.transfer(quote.id, key),
      context.pay(quote.id, key),
      context.transfer(quote.id, key),
      context.pay(quote.id, key),
    ]);
    expect(results.every((response) => response.statusCode === 200)).toBe(true);
    expect(new Set(results.map((response) => response.json().id)).size).toBe(1);
    const final = await context.reconcileTransfer(results[0]!.json().id);
    expect(final.json()).toMatchObject({
      transferStatus: 'succeeded',
      fundsStatus: 'debited',
      confirmation: {
        accountNumber: '0012345678',
        amountMinorUnits: '10000',
        currency: 'NGN',
      },
      failureReason: null,
    });
    expect(final.body).not.toContain(context.providerKey);
    expect(context.submit).toHaveBeenCalledTimes(1);
    expect((await context.balance()).availableMinorUnits).toBe(89_950n);
    expect((await context.balance()).reservedMinorUnits).toBe(0n);
    expect(
      await database.database
        .selectFrom('service_payment_outcomes')
        .select('payment_id')
        .where('payment_id', '=', final.json().id)
        .execute(),
    ).toHaveLength(1);
  });

  it('keeps delayed bank outcomes pending and held; lookup confirms original credit without another transfer or reservation', async () => {
    const context = await fixture('bank_transfer');
    const { quote } = await preparedBankTransfer(context);
    const response = await context.transfer(quote.id);
    expect(response.json()).toMatchObject({
      transferStatus: 'pending',
      fundsStatus: 'reserved',
      confirmation: null,
      failureReason: null,
    });
    context.setResult((payment) => ({
      ...succeeded(payment),
      fulfilment: bankCreditConfirmation(payment),
    }));
    const completed = await Promise.all(
      Array.from({ length: 4 }, () =>
        context.reconcileTransfer(response.json().id),
      ),
    );
    expect(completed.every((result) => result.statusCode === 200)).toBe(true);
    expect(completed[0]!.json()).toMatchObject({
      transferStatus: 'succeeded',
      fundsStatus: 'debited',
    });
    expect(context.submit).toHaveBeenCalledTimes(1);
    expect((await context.balance()).availableMinorUnits).toBe(89_950n);
  });

  it.each([
    'absent',
    'bank',
    'account',
    'name',
    'amount',
    'currency',
    'time',
    'reference',
  ] as const)(
    'does not store financial success or capture funds for %s recipient-credit proof',
    async (mode) => {
      const context = await fixture('bank_transfer');
      const { quote } = await preparedBankTransfer(context);
      context.setResult((payment) => ({
        ...succeeded(payment),
        ...(mode === 'absent'
          ? {}
          : {
              fulfilment: {
                ...bankCreditConfirmation(payment),
                ...(mode === 'bank' ? { bankId: randomUUID() } : {}),
                ...(mode === 'account' ? { accountNumber: '0012345679' } : {}),
                ...(mode === 'name' ? { accountName: 'Wrong Name' } : {}),
                ...(mode === 'amount' ? { amountMinorUnits: '9999' } : {}),
                ...(mode === 'currency' ? { currency: 'USD' } : {}),
                ...(mode === 'time'
                  ? { creditedAt: '2030-02-30T00:00:00.000Z' }
                  : {}),
                ...(mode === 'reference'
                  ? { transferReference: 'Bad\nReference' }
                  : {}),
              },
            }),
      }));
      const attempted = await context.transfer(quote.id);
      expect(attempted.statusCode).toBe(503);
      const payment = await database.database
        .selectFrom('service_payments')
        .select('id')
        .where('quote_id', '=', quote.id)
        .executeTakeFirstOrThrow();
      expect(
        await database.database
          .selectFrom('service_payment_outcomes')
          .select('payment_id')
          .where('payment_id', '=', payment.id)
          .execute(),
      ).toHaveLength(0);
      expect((await context.balance()).reservedMinorUnits).toBe(10_050n);
      context.setResult((instruction) => ({
        ...succeeded(instruction),
        fulfilment: bankCreditConfirmation(instruction),
      }));
      expect(
        (await context.reconcileTransfer(payment.id)).json().transferStatus,
      ).toBe('succeeded');
      expect(context.submit).toHaveBeenCalledTimes(1);
    },
  );

  it('rolls back financial evidence when credit-proof persistence fails and recovers it without resubmitting', async () => {
    const context = await fixture('bank_transfer');
    const { quote } = await preparedBankTransfer(context);
    context.setResult((payment) => ({
      ...succeeded(payment),
      fulfilment: bankCreditConfirmation(payment),
    }));
    const receipt = vi
      .spyOn(PostgresPaymentRepository.prototype, 'recordFulfilment')
      .mockRejectedValueOnce(new Error('Test receipt persistence outage'));
    try {
      expect((await context.transfer(quote.id)).statusCode).toBe(503);
      const payment = await database.database
        .selectFrom('service_payments')
        .select('id')
        .where('quote_id', '=', quote.id)
        .executeTakeFirstOrThrow();
      expect(
        await database.database
          .selectFrom('service_payment_outcomes')
          .select('payment_id')
          .where('payment_id', '=', payment.id)
          .execute(),
      ).toHaveLength(0);
      expect((await context.balance()).reservedMinorUnits).toBe(10_050n);
      expect(
        (await context.reconcileTransfer(payment.id)).json().transferStatus,
      ).toBe('succeeded');
      expect(context.submit).toHaveBeenCalledTimes(1);
    } finally {
      receipt.mockRestore();
    }
  });

  it('enforces mandatory bank credit proof at database commit without allowing direct incomplete success observations', async () => {
    const context = await fixture('bank_transfer');
    const { quote } = await preparedBankTransfer(context);
    const transfer = await context.transfer(quote.id);
    await expect(
      database.database
        .insertInto('service_payment_outcomes')
        .values({
          payment_id: transfer.json().id,
          provider_key: context.providerKey,
          outcome: 'succeeded',
          provider_transaction_reference: 'unproven-bank-credit',
          evidence_reference: 'private-claim',
        })
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
    expect(
      await database.database
        .selectFrom('service_payment_outcomes')
        .select('payment_id')
        .where('payment_id', '=', transfer.json().id)
        .execute(),
    ).toHaveLength(0);
    expect((await context.balance()).reservedMinorUnits).toBe(10_050n);
  });

  it('preserves held funds after transport exceptions and unsafe failures, then releases only independently safe failure with a separate reason', async () => {
    const context = await fixture('bank_transfer');
    const { quote } = await preparedBankTransfer(context);
    const key = randomUUID();
    context.submit.mockRejectedValueOnce(new Error('Bank submission timeout'));
    expect((await context.transfer(quote.id, key)).statusCode).toBe(503);
    const replay = await context.transfer(quote.id, key);
    expect(replay.json()).toMatchObject({
      transferStatus: 'pending',
      fundsStatus: 'reserved',
      failureReason: null,
    });
    context.setResult((payment) => failed(payment, false));
    expect(
      (await context.reconcileTransfer(replay.json().id)).json().transferStatus,
    ).toBe('pending');
    expect((await context.balance()).reservedMinorUnits).toBe(10_050n);
    context.setResult((payment) => ({
      ...failed(payment),
      outcome: 'failed',
      bankTransferFailureReason: 'bank_rejected',
    }));
    const rejected = await context.reconcileTransfer(replay.json().id);
    expect(rejected.json()).toMatchObject({
      transferStatus: 'failed',
      fundsStatus: 'released',
      failureReason: 'bank_rejected',
      confirmation: null,
    });
    expect((await context.balance()).availableMinorUnits).toBe(100_000n);
    expect(context.submit).toHaveBeenCalledTimes(1);
  });

  it('reports an honest generic confirmed-failure reason when no more specific bank reason is known', async () => {
    const context = await fixture('bank_transfer');
    const { quote } = await preparedBankTransfer(context);
    context.setResult((payment) => failed(payment));
    expect((await context.transfer(quote.id)).json()).toMatchObject({
      transferStatus: 'failed',
      fundsStatus: 'released',
      failureReason: 'transfer_not_completed',
    });
  });

  it('settles stored bank credit after a ledger outage even if the bank and adapter are withdrawn', async () => {
    const context = await fixture('bank_transfer');
    const { quote } = await preparedBankTransfer(context);
    context.setResult((payment) => ({
      ...succeeded(payment),
      fulfilment: bankCreditConfirmation(payment),
    }));
    const settlement = vi
      .spyOn(wallets, 'settleWalletReservation')
      .mockRejectedValueOnce(new Error('Ledger outage after bank credit'));
    try {
      expect((await context.transfer(quote.id)).statusCode).toBe(503);
      const payment = await database.database
        .selectFrom('service_payments')
        .select('id')
        .where('quote_id', '=', quote.id)
        .executeTakeFirstOrThrow();
      delete registrations[context.providerKey];
      await database.administrator
        .updateTable('bank_transfer_banks')
        .set({ is_enabled: false })
        .where('id', '=', context.bankId!)
        .execute();
      expect(
        (await context.reconcileTransfer(payment.id)).json(),
      ).toMatchObject({
        transferStatus: 'succeeded',
        fundsStatus: 'debited',
        confirmation: { accountNumber: '0012345678' },
      });
      expect(context.submit).toHaveBeenCalledTimes(1);
      expect(context.lookup).not.toHaveBeenCalled();
      expect((await context.balance()).availableMinorUnits).toBe(89_950n);
    } finally {
      settlement.mockRestore();
    }
  });

  it('stops new bank spending after withdrawal while preserving held transfer recovery and historical verification', async () => {
    const context = await fixture('bank_transfer');
    const { beneficiary, quote } = await preparedBankTransfer(context);
    const held = await context.transfer(quote.id);
    await database.administrator
      .updateTable('bank_transfer_banks')
      .set({ is_enabled: false })
      .where('id', '=', context.bankId!)
      .execute();
    const original = await application.inject({
      method: 'GET',
      url: `/v1/bank-transfers/quotes/${quote.id}`,
      headers: context.headers,
    });
    expect(original.json().isSubmissionAvailable).toBe(false);
    expect((await context.transferQuote(beneficiary.id)).statusCode).toBe(404);
    expect(
      (
        await application.inject({
          method: 'GET',
          url: `/v1/bank-transfers/beneficiary-validations/${beneficiary.id}`,
          headers: context.headers,
        })
      ).statusCode,
    ).toBe(200);
    context.setResult((payment) => ({
      ...succeeded(payment),
      fulfilment: bankCreditConfirmation(payment),
    }));
    expect(
      (await context.reconcileTransfer(held.json().id)).json().transferStatus,
    ).toBe('succeeded');
    expect(context.submit).toHaveBeenCalledTimes(1);
  });

  it('recovers lost responses by the original key and prevents ownership/category confusion across transfer and other services', async () => {
    const context = await fixture('bank_transfer');
    const { quote } = await preparedBankTransfer(context);
    const key = randomUUID();
    const held = await context.transfer(quote.id, key);
    delete registrations[context.providerKey];
    const recovered = await application.inject({
      method: 'GET',
      url: `/v1/bank-transfers/by-request-key?requestKey=${key}`,
      headers: context.headers,
    });
    expect(recovered.json()).toEqual(held.json());
    const other = await fixture();
    expect(
      (
        await application.inject({
          method: 'GET',
          url: `/v1/bank-transfers/${held.json().id}`,
          headers: other.headers,
        })
      ).statusCode,
    ).toBe(404);
    expect((await other.reconcileTransfer(held.json().id)).statusCode).toBe(
      404,
    );
    const mobileQuote = (await other.quote()).json();
    expect((await other.transfer(mobileQuote.id)).json().code).toBe(
      'BANK_TRANSFER_NOT_FOUND',
    );
    const mobile = await other.pay(mobileQuote.id);
    expect(
      (
        await application.inject({
          method: 'GET',
          url: `/v1/bank-transfers/${mobile.json().id}`,
          headers: other.headers,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('protects immutable bank/account rules, verified beneficiary history and final credit evidence under restricted runtime privileges', async () => {
    const context = await fixture('bank_transfer');
    const { beneficiary, quote } = await preparedBankTransfer(context);
    context.setResult((payment) => ({
      ...succeeded(payment),
      fulfilment: bankCreditConfirmation(payment),
    }));
    const transferred = await context.transfer(quote.id);
    await expect(
      database.administrator
        .updateTable('bank_transfer_banks')
        .set({ maximum_account_number_length: 11 })
        .where('id', '=', context.bankId!)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database.administrator
        .updateTable('bank_transfer_beneficiary_validations')
        .set({ account_number: '0012345679' })
        .where('id', '=', beneficiary.id)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database.administrator
        .updateTable('service_payment_fulfilments')
        .set({ fulfilment: sql`'{}'::jsonb` })
        .where('payment_id', '=', transferred.json().id)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database.database
        .updateTable('bank_transfer_banks')
        .set({ is_enabled: false })
        .where('id', '=', context.bankId!)
        .execute(),
    ).rejects.toMatchObject({ code: '42501' });
    expect((await context.balance()).availableMinorUnits).toBe(89_950n);
  });
});

describe('bank transfer spending and identity protections', () => {
  it.each([
    { outcome: 'succeeded' },
    { feeMinorUnits: '0' },
    { accountNumber: '0012345679' },
    { providerKey: 'caller-provider' },
    { ownerId: randomUUID() },
  ])('rejects submission overrides before spending: %j', async (overrides) => {
    const context = await fixture('bank_transfer');
    const { quote } = await preparedBankTransfer(context);
    expect(
      (await context.transfer(quote.id, randomUUID(), overrides)).statusCode,
    ).toBe(400);
    expect(context.submit).not.toHaveBeenCalled();
    expect((await context.balance()).reservedMinorUnits).toBe(0n);
  });

  it('uses exact transfer and confirmation amounts beyond JavaScript safe integer precision', async () => {
    const amountMinorUnits = 9_007_199_254_741_100n;
    const context = await fixture(
      'bank_transfer',
      amountMinorUnits + 1000n,
      amountMinorUnits,
    );
    const { quote } = await preparedBankTransfer(context, {
      amountMinorUnits: amountMinorUnits.toString(),
    });
    context.setResult((payment) => ({
      ...succeeded(payment),
      fulfilment: bankCreditConfirmation(payment),
    }));
    const transferred = await context.transfer(quote.id);
    expect(transferred.json()).toMatchObject({
      transferStatus: 'succeeded',
      confirmation: { amountMinorUnits: amountMinorUnits.toString() },
      quote: { totalDebitMinorUnits: (amountMinorUnits + 50n).toString() },
    });
    expect((await context.balance()).availableMinorUnits).toBe(950n);
  });

  it('prevents competing transfers spending the same available funds and keeps one accepted unfunded instruction recoverable', async () => {
    const context = await fixture('bank_transfer', 15_000n);
    const { beneficiary, quote } = await preparedBankTransfer(context);
    const second = await context.transferQuote(beneficiary.id);
    const results = await Promise.all([
      context.transfer(quote.id),
      context.transfer(second.json().id),
    ]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([
      200, 409,
    ]);
    expect(context.submit).toHaveBeenCalledTimes(1);
    expect((await context.balance()).availableMinorUnits).toBe(4_950n);
    expect((await context.balance()).reservedMinorUnits).toBe(10_050n);
  });

  it('rejects changed request-key/quote bindings and does not spend when a required verifier is removed after acceptance', async () => {
    const context = await fixture('bank_transfer', 0n);
    const { beneficiary, quote } = await preparedBankTransfer(context);
    const key = randomUUID();
    expect((await context.transfer(quote.id, key)).json().code).toBe(
      'INSUFFICIENT_FUNDS',
    );
    const second = await context.transferQuote(beneficiary.id);
    expect((await context.transfer(second.json().id, key)).json().code).toBe(
      'PAYMENT_CONFLICT',
    );
    registrations[context.providerKey] = {
      ...registrations[context.providerKey]!,
      bankBeneficiaryVerification: undefined,
    };
    expect((await context.transfer(quote.id, key)).json().code).toBe(
      'PAYMENT_UNAVAILABLE',
    );
    expect(context.submit).not.toHaveBeenCalled();
    expect((await context.balance()).reservedMinorUnits).toBe(0n);
  });

  it('does not let one provider economic movement confirm two distinct transfers', async () => {
    const context = await fixture('bank_transfer');
    const { beneficiary, quote } = await preparedBankTransfer(context);
    context.setResult((payment) => ({
      ...succeeded(payment),
      providerTransactionReference: 'one-bank-economic-movement',
      fulfilment: bankCreditConfirmation(payment),
    }));
    expect((await context.transfer(quote.id)).json().transferStatus).toBe(
      'succeeded',
    );
    const second = await context.transferQuote(beneficiary.id);
    expect((await context.transfer(second.json().id)).statusCode).toBe(503);
    expect((await context.balance()).availableMinorUnits).toBe(79_900n);
    expect((await context.balance()).reservedMinorUnits).toBe(10_050n);
    const secondPayment = await database.database
      .selectFrom('service_payments')
      .select('id')
      .where('quote_id', '=', second.json().id)
      .executeTakeFirstOrThrow();
    expect(
      await database.database
        .selectFrom('service_payment_outcomes')
        .select('payment_id')
        .where('payment_id', '=', secondPayment.id)
        .execute(),
    ).toHaveLength(0);
  });

  it('rejects frozen-wallet spending and narration on unrelated products without altering their established quote contracts', async () => {
    const context = await fixture('bank_transfer');
    const { quote } = await preparedBankTransfer(context);
    await database.administrator
      .updateTable('wallets')
      .set({ wallet_status: 'frozen' })
      .where('id', '=', context.wallet.id)
      .execute();
    expect((await context.transfer(quote.id)).json().code).toBe(
      'WALLET_RESTRICTED',
    );
    expect(context.submit).not.toHaveBeenCalled();
    const mobile = await fixture();
    expect(
      (await mobile.quote({ narration: 'Bank-only field' })).statusCode,
    ).toBe(400);
  });
});

it('shows confirmed bank failure and reason independently of a wallet-release outage, then restores funds without another bank call', async () => {
  const context = await fixture('bank_transfer');
  const { quote } = await preparedBankTransfer(context);
  context.setResult((payment) => ({
    ...failed(payment),
    bankTransferFailureReason: 'recipient_unavailable',
  }));
  const settlement = vi
    .spyOn(wallets, 'settleWalletReservation')
    .mockRejectedValueOnce(new Error('Wallet release outage'));
  try {
    expect((await context.transfer(quote.id)).statusCode).toBe(503);
    const payment = await database.database
      .selectFrom('service_payments')
      .select('id')
      .where('quote_id', '=', quote.id)
      .executeTakeFirstOrThrow();
    const before = await application.inject({
      method: 'GET',
      url: `/v1/bank-transfers/${payment.id}`,
      headers: context.headers,
    });
    expect(before.json()).toMatchObject({
      transferStatus: 'pending',
      bankOutcome: 'failed',
      fundsStatus: 'reserved',
      failureReason: 'recipient_unavailable',
    });
    delete registrations[context.providerKey];
    const completed = await context.reconcileTransfer(payment.id);
    expect(completed.json()).toMatchObject({
      transferStatus: 'failed',
      bankOutcome: 'failed',
      fundsStatus: 'released',
      failureReason: 'recipient_unavailable',
    });
    expect(context.lookup).not.toHaveBeenCalled();
    expect((await context.balance()).availableMinorUnits).toBe(100_000n);
  } finally {
    settlement.mockRestore();
  }
});

/** Wire the actual VTpass processor/adapter into real wallet and payment persistence, replacing only external HTTP. */
async function vtpassPaymentFixture(networkCode = 'mtn') {
  const providerKey = `vtpass:sandbox:${randomUUID()}`;
  const context = await fixture(
    'airtime',
    100_000n,
    90_000n,
    'prepaid',
    'institution_fee',
    {
      providerKey,
      networkCode,
      productCode: 'mtn',
    },
  );
  let purchase: Record<string, unknown> | undefined;
  let outcome: 'delivered' | 'failed' | 'timeout' = 'delivered';
  const transport = vi.fn<AxiosAdapter>().mockImplementation(async (config) => {
    const request = parseVtpassJson(config.data as string);
    const isPurchase = config.url!.endsWith('/api/pay');
    if (isPurchase) {
      purchase = request;
    }
    if (isPurchase && outcome === 'timeout') {
      throw new AxiosError('Acknowledgement lost', AxiosError.ETIMEDOUT);
    }
    if (!purchase) {
      throw new Error('No existing provider purchase');
    }
    return axiosTextResponse(
      JSON.stringify({
        code: outcome === 'failed' ? '016' : '000',
        requestId: request.request_id,
        amount: purchase.amount,
        content: {
          transactions: {
            status: outcome === 'failed' ? 'failed' : 'delivered',
            product_name: 'MTN Airtime VTU',
            type: 'Airtime Recharge',
            unique_element: purchase.phone,
            phone: 'merchant-contact',
            unit_price: purchase.amount,
            amount: purchase.amount,
            quantity: 1,
            transactionId: '17415980564672211596777904',
          },
        },
      }),
    );
  });
  const adapter = new VtpassAirtimeAdapter(
    {
      providerKey,
      environment: 'sandbox',
      apiKey: 'test-api-key',
      secretKey: 'test-secret-key',
    },
    transport,
  );
  registrations[providerKey] = {
    partnerAccountId: context.partnerAccountId,
    feeAccountId: context.feeAccountId,
    adapter: new AirtimeProcessor(adapter),
  };
  return {
    ...context,
    transport,
    adapter,
    /** Change test-authenticated provider state without bypassing its HTTP mapping or wallet settlement. */
    setOutcome(next: typeof outcome) {
      outcome = next;
    },
  };
}

describe('VTpass airtime with authoritative wallet settlement', () => {
  it('captures exactly one reservation from correlated delivered evidence and preserves request replay', async () => {
    const context = await vtpassPaymentFixture();
    const quote = (await context.quote()).json<PaymentQuoteResponseDto>();
    expect(quote.isSubmissionAvailable).toBe(true);
    const key = randomUUID();
    const response = await context.pay(quote.id, key);
    expect(response.statusCode).toBe(200);
    expect(response.json().paymentStatus).toBe('succeeded');
    expect((await context.pay(quote.id, key)).json().id).toBe(
      response.json().id,
    );
    expect(context.transport).toHaveBeenCalledTimes(1);
    expect((await context.balance()).reservedMinorUnits).toBe(0n);
    expect((await context.balance()).availableMinorUnits).toBe(89_950n);
  });

  it('keeps a timed-out purchase held and recovers through the same request reference without repurchasing', async () => {
    const context = await vtpassPaymentFixture();
    context.setOutcome('timeout');
    const quote = (await context.quote()).json<PaymentQuoteResponseDto>();
    const key = randomUUID();
    expect((await context.pay(quote.id, key)).statusCode).toBe(503);
    const replay = await context.pay(quote.id, key);
    expect(replay.json().paymentStatus).toBe('pending');
    expect((await context.balance()).reservedMinorUnits).toBe(10_050n);
    const purchase = parseVtpassJson(
      context.transport.mock.calls[0]![0]!.data as string,
    );
    context.setOutcome('delivered');
    currentTime = new Date(currentTime.getTime() + 23 * 3_600_000);
    expect(
      (await context.reconcile(replay.json().id)).json().paymentStatus,
    ).toBe('succeeded');
    expect(context.transport).toHaveBeenCalledTimes(2);
    expect(context.transport.mock.calls[1]![0]!.url).toBe(
      'https://sandbox.vtpass.com/api/requery',
    );
    expect(
      parseVtpassJson(context.transport.mock.calls[1]![0]!.data as string)
        .request_id,
    ).toBe(purchase.request_id);
    expect((await context.balance()).reservedMinorUnits).toBe(0n);
    expect((await context.balance()).availableMinorUnits).toBe(89_950n);
  });

  it('releases a fully correlated outright failure without debiting customer funds', async () => {
    const context = await vtpassPaymentFixture();
    context.setOutcome('failed');
    const quote = (await context.quote()).json<PaymentQuoteResponseDto>();
    const response = await context.pay(quote.id);
    expect(response.json().paymentStatus).toBe('failed');
    expect((await context.balance()).reservedMinorUnits).toBe(0n);
    expect((await context.balance()).availableMinorUnits).toBe(100_000n);
    expect(context.transport).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported recipient encoding before accepting or reserving money', async () => {
    const context = await vtpassPaymentFixture();
    const quote = (
      await context.quote({ recipientPhoneNumber: '+15551234567' })
    ).json<PaymentQuoteResponseDto>();
    expect(quote.isSubmissionAvailable).toBe(false);
    const response = await context.pay(quote.id);
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('INVALID_PAYMENT');
    expect((await context.balance()).availableMinorUnits).toBe(100_000n);
    expect((await context.balance()).reservedMinorUnits).toBe(0n);
    expect(context.transport).not.toHaveBeenCalled();
  });

  it('reports unsupported catalogue mappings unavailable before holding funds', async () => {
    const context = await vtpassPaymentFixture('glo');
    const quote = (await context.quote()).json<PaymentQuoteResponseDto>();
    expect(quote.isSubmissionAvailable).toBe(false);
    expect((await context.pay(quote.id)).json().code).toBe(
      'PAYMENT_UNAVAILABLE',
    );
    expect((await context.balance()).reservedMinorUnits).toBe(0n);
    expect(context.transport).not.toHaveBeenCalled();
  });
});

/** Isolate the next recovery candidate without moving the application or database clock. */
async function makeRecoveryDue(paymentId: string): Promise<void> {
  await sql`update service_payment_recovery set next_attempt_at = now() + interval '1 day'
    where recovery_status = 'pending'`.execute(database.administrator);
  await sql`update service_payment_recovery set next_attempt_at = now() - interval '1 second'
    where payment_id = ${paymentId}`.execute(database.administrator);
}

describe('durable payment recovery', () => {
  it('settles an accepted payment after its adapter stops accepting those terms for new purchases', async () => {
    const context = await vtpassPaymentFixture();
    context.setOutcome('timeout');
    const quote = (await context.quote()).json<PaymentQuoteResponseDto>();
    const key = randomUUID();
    expect((await context.pay(quote.id, key)).statusCode).toBe(503);
    const payments = new PostgresPaymentRepository(database.database);
    const accepted = (await payments.findByRequestKey(
      context.session.account.id,
      key,
    ))!;
    const validate = vi
      .spyOn(context.adapter, 'validate')
      .mockImplementation(() => {
        throw new PaymentError('PAYMENT_UNAVAILABLE', {
          reason: 'PRODUCT_NOT_SUPPORTED',
        });
      });
    try {
      expect(() =>
        context.adapter.validate({ scope: 'quote', terms: accepted.quote }),
      ).toThrow(expect.objectContaining({ reason: 'PRODUCT_NOT_SUPPORTED' }));
      validate.mockClear();
      context.setOutcome('delivered');
      await makeRecoveryDue(accepted.id);
      await application.get(PaymentRecoveryService).recoverDueBatch(4);
      expect(validate).not.toHaveBeenCalled();
      expect(await payments.getPayment(accepted.id)).toMatchObject({
        submissionStartedAt: accepted.submissionStartedAt,
        reservationStatus: 'captured',
        outcome: { outcome: 'succeeded' },
      });
      expect(
        await new PostgresPaymentRecoveryRepository(
          database.database,
        ).getProgress(accepted.id),
      ).toMatchObject({ status: 'completed' });
      expect((await context.balance()).reservedMinorUnits).toBe(0n);
      expect((await context.balance()).availableMinorUnits).toBe(89_950n);
      expect(
        context.transport.mock.calls.map(([config]) =>
          config.url?.split('/').at(-1),
        ),
      ).toEqual(['pay', 'requery']);
      expect(
        parseVtpassJson(context.transport.mock.calls[1]![0].data as string)
          .request_id,
      ).toBe(
        parseVtpassJson(context.transport.mock.calls[0]![0].data as string)
          .request_id,
      );
    } finally {
      validate.mockRestore();
    }
  });

  it('persists intent with the hold and settles a timed-out purchase without another purchase or client request', async () => {
    const context = await vtpassPaymentFixture();
    context.setOutcome('timeout');
    const quote = (await context.quote()).json<PaymentQuoteResponseDto>();
    const key = randomUUID();
    expect((await context.pay(quote.id, key)).statusCode).toBe(503);
    const payments = new PostgresPaymentRepository(database.database);
    const payment = (await payments.findByRequestKey(
      context.session.account.id,
      key,
    ))!;
    const recovery = new PostgresPaymentRecoveryRepository(database.database);
    expect(await recovery.getProgress(payment.id)).toMatchObject({
      status: 'pending',
      automaticAttempts: 0,
    });
    await makeRecoveryDue(payment.id);
    context.setOutcome('delivered');
    await application.get(PaymentRecoveryService).recoverDueBatch(4);
    expect(await recovery.getProgress(payment.id)).toMatchObject({
      status: 'completed',
      automaticAttempts: 1,
      totalAttempts: 1,
    });
    expect(
      (await payments.getPayment(payment.id))?.submissionStartedAt,
    ).toEqual(payment.submissionStartedAt);
    expect((await context.balance()).availableMinorUnits).toBe(89_950n);
    expect((await context.balance()).reservedMinorUnits).toBe(0n);
    expect(
      context.transport.mock.calls.map(([config]) =>
        config.url?.split('/').at(-1),
      ),
    ).toEqual(['pay', 'requery']);
  });

  it('recovers a process exit after the hold but before the first dispatch', async () => {
    const context = await vtpassPaymentFixture();
    const quote = (await context.quote()).json<PaymentQuoteResponseDto>();
    const key = randomUUID();
    const dispatch = vi
      .spyOn(application.get(PaymentExecutionService), 'dispatch')
      .mockRejectedValueOnce(new Error('process exit before dispatch'));
    try {
      expect((await context.pay(quote.id, key)).statusCode).toBe(503);
    } finally {
      dispatch.mockRestore();
    }
    const payment = (await new PostgresPaymentRepository(
      database.database,
    ).findByRequestKey(context.session.account.id, key))!;
    expect(payment.submissionStartedAt).toBeNull();
    expect((await context.balance()).reservedMinorUnits).toBe(10_050n);
    await makeRecoveryDue(payment.id);
    await application.get(PaymentRecoveryService).recoverDueBatch(4);
    expect((await context.balance()).reservedMinorUnits).toBe(0n);
    expect(context.transport).toHaveBeenCalledTimes(1);
    expect(context.transport.mock.calls[0]![0].url).toContain('/api/pay');
  });

  it('escalates a crash after the claim with only not-found observations, retaining the hold and original identity through operator retry', async () => {
    const context = await vtpassPaymentFixture();
    const quote = (await context.quote()).json<PaymentQuoteResponseDto>();
    const key = randomUUID();
    const payments = new PostgresPaymentRepository(database.database);
    const dispatch = vi
      .spyOn(application.get(PaymentExecutionService), 'dispatch')
      .mockImplementationOnce(async (payment) => {
        await payments.claimSubmission(payment.id);
        throw new Error('process exit after claim');
      });
    try {
      expect((await context.pay(quote.id, key)).statusCode).toBe(503);
    } finally {
      dispatch.mockRestore();
    }
    const payment = (await payments.findByRequestKey(
      context.session.account.id,
      key,
    ))!;
    context.transport.mockResolvedValue(axiosTextResponse('{"code":"015"}'));
    const service = application.get(PaymentRecoveryService);
    const recovery = new PostgresPaymentRecoveryRepository(database.database);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await makeRecoveryDue(payment.id);
      await service.recoverDueBatch(4);
    }
    expect(await recovery.getProgress(payment.id)).toMatchObject({
      status: 'needs_review',
      automaticAttempts: 8,
      totalAttempts: 8,
      lastFailureCode: 'PROVIDER_UNCONFIRMED',
    });
    await makeRecoveryDue(payment.id);
    await service.recoverDueBatch(4);
    expect(context.transport).toHaveBeenCalledTimes(8);
    expect(await service.retryReview(payment.id)).toBe(true);
    await service.recoverDueBatch(4);
    expect(await recovery.getProgress(payment.id)).toMatchObject({
      status: 'pending',
      automaticAttempts: 1,
      totalAttempts: 9,
    });
    expect((await context.balance()).reservedMinorUnits).toBe(10_050n);
    expect((await context.balance()).availableMinorUnits).toBe(89_950n);
    expect(
      (await payments.getPayment(payment.id))?.submissionStartedAt,
    ).toEqual(payment.submissionStartedAt);
    expect(
      context.transport.mock.calls.every(([config]) =>
        config.url?.endsWith('/api/requery'),
      ),
    ).toBe(true);
    const references = context.transport.mock.calls.map(
      ([config]) => parseVtpassJson(config.data as string).request_id,
    );
    expect(new Set(references).size).toBe(1);
  });

  it('fences concurrent claims and stale completions, recovering an expired lease without resetting its attempts', async () => {
    const context = await vtpassPaymentFixture();
    context.setOutcome('timeout');
    const quote = (await context.quote()).json<PaymentQuoteResponseDto>();
    const key = randomUUID();
    await context.pay(quote.id, key);
    const payment = (await new PostgresPaymentRepository(
      database.database,
    ).findByRequestKey(context.session.account.id, key))!;
    await makeRecoveryDue(payment.id);
    const repository = new PostgresPaymentRecoveryRepository(database.database);
    const batches = await Promise.all([
      repository.claimDue(1),
      repository.claimDue(1),
    ]);
    const claims = batches.flat();
    expect(claims).toHaveLength(1);
    const original = claims[0]!;
    await sql`update service_payment_recovery set lease_expires_at = now() - interval '1 second'
      where payment_id = ${payment.id}`.execute(database.administrator);
    const replacement = (await repository.claimDue(1))[0]!;
    expect(replacement.automaticAttempts).toBe(2);
    expect(replacement.leaseToken).not.toBe(original.leaseToken);
    expect(
      await repository.finishAttempt(original, {
        status: 'completed',
        retryDelaySeconds: 0,
        failureCode: null,
      }),
    ).toBe(false);
    expect(await repository.getProgress(payment.id)).toMatchObject({
      status: 'pending',
      totalAttempts: 2,
    });
    expect(
      await repository.finishAttempt(replacement, {
        status: 'pending',
        retryDelaySeconds: 60,
        failureCode: 'PROVIDER_UNCONFIRMED',
      }),
    ).toBe(true);
  });

  it('escalates expired leases whose automatic budget was consumed by repeated process exits', async () => {
    const context = await vtpassPaymentFixture();
    context.setOutcome('timeout');
    const quote = (await context.quote()).json<PaymentQuoteResponseDto>();
    const key = randomUUID();
    await context.pay(quote.id, key);
    const payment = (await new PostgresPaymentRepository(
      database.database,
    ).findByRequestKey(context.session.account.id, key))!;
    await makeRecoveryDue(payment.id);
    const repository = new PostgresPaymentRecoveryRepository(database.database);
    await sql`update service_payment_recovery set automatic_attempts = 8, total_attempts = 8,
      lease_token = gen_random_uuid(), lease_expires_at = now() - interval '1 second'
      where payment_id = ${payment.id}`.execute(database.administrator);
    expect(await repository.claimDue(1)).toEqual([]);
    expect(await repository.getProgress(payment.id)).toMatchObject({
      status: 'needs_review',
      totalAttempts: 8,
      lastFailureCode: 'RECOVERY_INTERRUPTED',
    });
    expect((await context.balance()).reservedMinorUnits).toBe(10_050n);
  });

  it('rolls back recovery intent when the hold transaction fails after reservation insertion', async () => {
    const context = await vtpassPaymentFixture();
    const quote = (await context.quote()).json<PaymentQuoteResponseDto>();
    const key = randomUUID();
    await sql`create function fail_recovery_hold_test() returns trigger language plpgsql as $$
      begin raise exception 'simulated ledger write outage'; end $$;
      create trigger fail_recovery_hold_test before insert on ledger_entries
      for each row execute function fail_recovery_hold_test();`.execute(
      database.administrator,
    );
    try {
      expect((await context.pay(quote.id, key)).statusCode).toBe(503);
    } finally {
      await sql`drop trigger fail_recovery_hold_test on ledger_entries; drop function fail_recovery_hold_test();`.execute(
        database.administrator,
      );
    }
    const payment = (await new PostgresPaymentRepository(
      database.database,
    ).findByRequestKey(context.session.account.id, key))!;
    expect(
      await new PostgresPaymentRecoveryRepository(
        database.database,
      ).getProgress(payment.id),
    ).toBeNull();
    expect((await context.balance()).availableMinorUnits).toBe(100_000n);
    expect(context.transport).not.toHaveBeenCalled();
  });
});
