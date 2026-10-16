/** Exercise authenticated conversion contracts, immutable SQL evidence, exact ledger credit and failure recovery in disposable PostgreSQL. */
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RequestValidationModule } from '../../src/bootstrap/request-validation.module.js';
import { validateEnvironment } from '../../src/infrastructure/config/environment.js';
import { DatabaseConnection } from '@axiapay/payments-runtime/infrastructure/database/database.module';
import { WalletHttpModule } from '../../src/modules/wallets/wallet-http.module.js';
import { WalletModule } from '@axiapay/payments-runtime/modules/wallets/wallet.module';
import { WalletService } from '@axiapay/payments-runtime/modules/wallets/services/wallet.service';
import { money } from '@axiapay/payments-runtime/modules/wallets/domain/money';
import { AirtimeConversionModule } from '../../src/modules/airtime-conversion/airtime-conversion.module.js';
import {
  ConversionError,
  type ConversionOffer,
} from '../../src/modules/airtime-conversion/domain/conversion.js';
import type {
  AirtimeConversionProvider,
  ConversionEligibilityInput,
  ConversionInspection,
  ConversionRoute,
  ConversionTransferInput,
  VerifiedAirtimeReceipt,
} from '../../src/modules/airtime-conversion/ports/airtime-conversion-provider.js';
import {
  startWalletTestDatabase,
  type WalletTestDatabase,
} from '../../../../packages/payments-runtime/tests/support/wallet-test-database.js';
import {
  createFundingCustomer,
  type FundingCustomer,
} from '../support/funding-test-customer.js';

/** Fixture adapter implements only owned capability contracts; it never sends airtime or reaches an external system. */
class ContractConversionProvider implements AirtimeConversionProvider {
  readonly prepares: ConversionTransferInput[] = [];
  readonly inspections: ConversionTransferInput[] = [];
  readonly eligibilityInputs: ConversionEligibilityInput[] = [];
  readonly replies = new Map<string, ConversionInspection>();
  isEligible = true;
  losePreparationResponse = false;
  lookupUnavailable = false;
  eligibilityValidityMs = 600000;

  /** Return controlled authoritative eligibility for exactly the requested source and face value. */
  async checkEligibility(input: ConversionEligibilityInput) {
    this.eligibilityInputs.push(input);
    if (!this.isEligible) {
      return { isEligible: false } as const;
    }
    return {
      isEligible: true,
      eligibilityReference: `eligibility:${randomUUID()}`,
      expiresAt: new Date(Date.now() + this.eligibilityValidityMs),
    } as const;
  }

  /** Save instructions before optionally losing their response, reproducing accepted external preparation uncertainty. */
  async prepareTransfer(
    input: ConversionTransferInput,
  ): Promise<ConversionInspection> {
    this.prepares.push(input);
    const reply: ConversionInspection = {
      conversionId: input.conversionId,
      requestFingerprint: input.requestFingerprint,
      receiptStatus: 'pending',
      instructions: {
        instructionReference: `instructions:${randomUUID()}`,
        receivingPhoneNumber: '+2348098765432',
        description:
          'Transfer the reviewed airtime face value from the selected source number before the deadline.',
        issuedAt: new Date(),
      },
    };
    this.replies.set(input.conversionId, reply);
    if (this.losePreparationResponse) {
      throw new Error('Fixture response lost; private upstream details');
    }
    return reply;
  }

  /** Non-executing original identity lookup; network uncertainty never becomes a verified failure. */
  async inspectTransfer(
    input: ConversionTransferInput,
  ): Promise<ConversionInspection> {
    this.inspections.push(input);
    if (this.lookupUnavailable) {
      throw new Error('Fixture unavailable; private upstream details');
    }
    const reply = this.replies.get(input.conversionId);
    if (!reply) {
      throw new ConversionError('CONVERSION_UNAVAILABLE');
    }
    return reply;
  }

  /** Publish a matching canonical receipt, with controlled variations for monetary and correlation assertions. */
  receive(
    conversionId: string,
    overrides: Partial<VerifiedAirtimeReceipt> = {},
  ): VerifiedAirtimeReceipt {
    const input = this.prepares.find(
      (candidate) => candidate.conversionId === conversionId,
    )!;
    const prior = this.replies.get(conversionId)!;
    const receipt: VerifiedAirtimeReceipt = {
      conversionId,
      requestFingerprint: input.requestFingerprint,
      externalMovementId: `airtime-receipt:${randomUUID()}`,
      evidenceReference: `verified:${randomUUID()}`,
      sourcePhoneNumber: input.sourcePhoneNumber,
      networkCode: input.networkCode,
      receivingPhoneNumber: prior.instructions!.receivingPhoneNumber,
      instructionReference: prior.instructions!.instructionReference,
      airtimeValue: input.airtimeValue,
      netCreditValue: input.netCreditValue,
      receivedAt: new Date(),
      ...overrides,
    };
    this.replies.set(conversionId, {
      ...prior,
      receiptStatus: 'received',
      receipt,
    });
    return receipt;
  }
}

/** Test-only commercial terms; production has no configured network, rate, fee or provider. */
const offer: ConversionOffer & { readonly providerProductCode: string } = {
  id: 'test-network-airtime',
  displayName: 'Test airtime conversion',
  networkCode: 'test-network',
  currency: 'NGN',
  termsVersion: 'test-v1',
  rateNumerator: 4n,
  rateDenominator: 5n,
  fixedFeeMinorUnits: 100n,
  feeBasisPoints: 125,
  minimumAirtimeMinorUnits: 1000n,
  maximumAirtimeMinorUnits: 1000000n,
  airtimeStepMinorUnits: 100n,
  quoteValiditySeconds: 300,
  transferWindowSeconds: 900,
  providerProductCode: 'fixture-airtime-inbound',
};
const provider = new ContractConversionProvider();
const partnerAccountId = randomUUID();
const replacementAccountId = randomUUID();
let database: WalletTestDatabase;
let application: NestFastifyApplication;
const applications: NestFastifyApplication[] = [];

/** Bind a fixture realm and administrator-provisioned clearing account; route variations test disabled and replaced capabilities. */
function route(overrides: Partial<ConversionRoute> = {}): ConversionRoute {
  return {
    providerId: 'test-conversion-realm',
    partnerAccountId,
    provider,
    acceptsNewRequests: true,
    offers: [offer],
    ...overrides,
  };
}

/** Compose actual HTTP/auth/SQL/ledger modules, with only test capabilities and a restricted database connection. */
async function createConversionApplication(
  routes: readonly ConversionRoute[] = [],
  storage = database,
): Promise<NestFastifyApplication> {
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ validate: validateEnvironment }),
      RequestValidationModule,
      WalletHttpModule,
      AirtimeConversionModule.register({ routes: { useValue: routes } }),
    ],
  })
    .overrideProvider(DatabaseConnection)
    .useValue({ database: storage.database })
    .compile();
  const app = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    { logger: false },
  );
  app.setGlobalPrefix('v1');
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  applications.push(app);
  return app;
}

beforeAll(async () => {
  database = await startWalletTestDatabase();
  await sql`select grant_airtime_conversion_runtime_access('wallet_runtime'); grant select on auth_accounts, auth_sessions to wallet_runtime`.execute(
    database.administrator,
  );
  await database.administrator
    .insertInto('ledger_accounts')
    .values(
      [partnerAccountId, replacementAccountId].map((id) => ({
        id,
        account_code: `conversion-test:${id}`,
        account_kind: 'partner_funds',
        currency: 'NGN',
        wallet_id: null,
      })),
    )
    .execute();
  application = await createConversionApplication([route()]);
});
beforeEach(() => {
  provider.isEligible = true;
  provider.losePreparationResponse = false;
  provider.lookupUnavailable = false;
  provider.eligibilityValidityMs = 600000;
});
afterAll(async () => {
  await Promise.all(applications.map((app) => app.close()));
  await database?.stop();
});

/** Use the real opaque session for every customer request. */
function authorization(customer: FundingCustomer) {
  return { authorization: `Bearer ${customer.token}` };
}

/** Prepare an owned source and exact face value through the public eligibility/quote endpoint. */
async function quote(
  customer: FundingCustomer,
  overrides: Record<string, unknown> = {},
  app = application,
) {
  return app.inject({
    method: 'POST',
    url: '/v1/airtime-conversions/quotes',
    headers: authorization(customer),
    payload: {
      walletId: customer.walletId,
      offerId: offer.id,
      sourcePhoneNumber: '+2348012345678',
      airtimeMinorUnits: '100000',
      ...overrides,
    },
  });
}

/** Acceptance includes explicit quote consent and a stable logical key only. */
function accept(
  customer: FundingCustomer,
  quoteId: string,
  requestKey = randomUUID(),
  app = application,
) {
  return app.inject({
    method: 'POST',
    url: '/v1/airtime-conversions',
    headers: authorization(customer),
    payload: { quoteId, requestKey },
  });
}

/** Create a pending conversion with real owned terms; preparing never increases funds. */
async function pending(customer: FundingCustomer, app = application) {
  const review = await quote(customer, {}, app);
  expect(review.statusCode).toBe(201);
  const response = await accept(
    customer,
    review.json().quoteId,
    randomUUID(),
    app,
  );
  expect(response.statusCode).toBe(202);
  return response.json();
}

/** Request independent lookup without any client payment evidence. */
function reconcile(
  customer: FundingCustomer,
  conversionId: string,
  app = application,
) {
  return app.inject({
    method: 'POST',
    url: `/v1/airtime-conversions/${conversionId}/reconcile`,
    headers: authorization(customer),
  });
}

/** Observe authoritative ledger balance through the owned wallet route. */
async function balance(
  customer: FundingCustomer,
  app = application,
): Promise<bigint> {
  const response = await app.inject({
    method: 'GET',
    url: `/v1/wallets/${customer.walletId}/balance`,
    headers: authorization(customer),
  });
  expect(response.statusCode).toBe(200);
  return BigInt(response.json().availableMinorUnits);
}

describe('airtime conversion financial workflow', () => {
  it('discloses eligibility, rates, fees, net credit and limits before preparing instructions', async () => {
    const customer = await createFundingCustomer(application, database);
    const preparations = provider.prepares.length;
    const review = await quote(customer);
    expect(review.statusCode).toBe(201);
    expect(review.json()).toMatchObject({
      airtimeMinorUnits: '100000',
      grossCreditMinorUnits: '80000',
      feeMinorUnits: '1100',
      netCreditMinorUnits: '78900',
      offer: {
        networkCode: 'test-network',
        rateNumerator: '4',
        rateDenominator: '5',
        fixedFeeMinorUnits: '100',
        feeBasisPoints: 125,
        minimumAirtimeMinorUnits: '1000',
        maximumAirtimeMinorUnits: '1000000',
        airtimeStepMinorUnits: '100',
        calculationBasis: 'airtime_face_value_minor_units',
        grossCreditRounding: 'floor',
        proportionalFeeRounding: 'ceil',
      },
    });
    expect(provider.eligibilityInputs.at(-1)).toMatchObject({
      sourcePhoneNumber: '+2348012345678',
      networkCode: offer.networkCode,
      airtimeValue: money(100000n, 'NGN'),
    });
    expect(provider.prepares.length).toBe(preparations);
    const accepted = await accept(customer, review.json().quoteId);
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({
      conversionStatus: 'awaiting_receipt',
      operationId: null,
      nextAction: 'follow_transfer_instructions',
      instructions: { receivingPhoneNumber: '+2348098765432' },
    });
    expect(accepted.headers['cache-control']).toBe('no-store');
    expect(await balance(customer)).toBe(0n);
    expect(
      (await reconcile(customer, accepted.json().conversionId)).json()
        .conversionStatus,
    ).toBe('awaiting_receipt');
    expect(await balance(customer)).toBe(0n);
  });
  it('posts only the expected net amount once across concurrent reconciliation and consent replays', async () => {
    const customer = await createFundingCustomer(application, database);
    const conversion = await pending(customer);
    provider.receive(conversion.conversionId);
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        reconcile(customer, conversion.conversionId),
      ),
    );
    expect(
      responses.every(
        (response) =>
          response.statusCode === 200 &&
          response.json().conversionStatus === 'credited',
      ),
    ).toBe(true);
    const operationIds = new Set(
      responses.map((response) => response.json().operationId),
    );
    expect(operationIds.size).toBe(1);
    const replay = await accept(
      customer,
      conversion.quote.quoteId,
      conversion.requestKey,
    );
    expect(replay.json().operationId).toBe(responses[0]!.json().operationId);
    expect(await balance(customer)).toBe(78900n);
    const entries = await database.administrator
      .selectFrom('ledger_entries')
      .select(['entry_side', 'amount_minor_units'])
      .where('journal_id', '=', responses[0]!.json().operationId)
      .execute();
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => BigInt(entry.amount_minor_units))).toEqual([
      78900n,
      78900n,
    ]);
    expect(new Set(entries.map((entry) => entry.entry_side))).toEqual(
      new Set(['debit', 'credit']),
    );
  });
  it('serializes concurrent acceptance to a single conversion and external preparation', async () => {
    const customer = await createFundingCustomer(application, database);
    const review = await quote(customer);
    const start = provider.prepares.length;
    const key = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        accept(customer, review.json().quoteId, key),
      ),
    );
    expect(responses.every((response) => response.statusCode === 202)).toBe(
      true,
    );
    expect(
      new Set(responses.map((response) => response.json().conversionId)).size,
    ).toBe(1);
    expect(provider.prepares.length - start).toBe(1);
    expect(await balance(customer)).toBe(0n);
  });
  it('rejects a second logical key for a consumed quote and a changed quote under the original key', async () => {
    const customer = await createFundingCustomer(application, database);
    const first = await quote(customer);
    const second = await quote(customer);
    const key = randomUUID();
    expect((await accept(customer, first.json().quoteId, key)).statusCode).toBe(
      202,
    );
    for (const [quoteId, requestKey] of [
      [first.json().quoteId, randomUUID()],
      [second.json().quoteId, key],
    ]) {
      const conflict = await accept(customer, quoteId, requestKey);
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().code).toBe('CONVERSION_CONFLICT');
    }
  });
  it('recovers lost preparation by lookup of the original identity, without submitting again', async () => {
    const customer = await createFundingCustomer(application, database);
    const review = await quote(customer);
    const key = randomUUID();
    const start = provider.prepares.length;
    provider.losePreparationResponse = true;
    const response = await accept(customer, review.json().quoteId, key);
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('private upstream');
    const found = await application.inject({
      method: 'GET',
      url: `/v1/airtime-conversions/by-request-key?requestKey=${key}`,
      headers: authorization(customer),
    });
    expect(found.statusCode).toBe(200);
    expect(found.json().conversionStatus).toBe('preparing');
    const replay = await accept(customer, review.json().quoteId, key);
    expect(replay.json().conversionId).toBe(found.json().conversionId);
    const recovered = await reconcile(customer, found.json().conversionId);
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json().conversionStatus).toBe('awaiting_receipt');
    expect(provider.prepares.length - start).toBe(1);
    expect(provider.inspections.at(-1)).toEqual(provider.prepares.at(-1));
    expect(await balance(customer)).toBe(0n);
  });
  it('preserves pending state and original evidence after a lookup outage', async () => {
    const customer = await createFundingCustomer(application, database);
    const conversion = await pending(customer);
    provider.lookupUnavailable = true;
    const response = await reconcile(customer, conversion.conversionId);
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('CONVERSION_UNAVAILABLE');
    expect(response.body).not.toContain('private upstream');
    const stored = await application.inject({
      method: 'GET',
      url: `/v1/airtime-conversions/${conversion.conversionId}`,
      headers: authorization(customer),
    });
    expect(stored.json().conversionStatus).toBe('awaiting_receipt');
    expect(await balance(customer)).toBe(0n);
  });
  it.each([
    [
      'wrong face value',
      { airtimeValue: money(99900n, 'NGN') },
      'amount_mismatch',
    ],
    [
      'wrong currency',
      { airtimeValue: money(100000n, 'USD') },
      'amount_mismatch',
    ],
    [
      'repriced net credit',
      { netCreditValue: money(78800n, 'NGN') },
      'terms_mismatch',
    ],
    ['wrong source', { sourcePhoneNumber: '+2348000000000' }, 'terms_mismatch'],
    ['wrong network', { networkCode: 'different-network' }, 'terms_mismatch'],
    [
      'wrong destination',
      { receivingPhoneNumber: '+2348000000000' },
      'terms_mismatch',
    ],
    [
      'wrong instructions',
      { instructionReference: 'different-reference' },
      'terms_mismatch',
    ],
    ['wrong conversion', { conversionId: randomUUID() }, 'verification_failed'],
    [
      'wrong correlation',
      { requestFingerprint: 'incorrect' },
      'verification_failed',
    ],
    [
      'invalid receipt timestamp',
      { receivedAt: new Date('invalid') },
      'verification_failed',
    ],
  ] as const)(
    'retains a visible exception for %s without credit',
    async (_label, overrides, exceptionCode) => {
      const customer = await createFundingCustomer(application, database);
      const conversion = await pending(customer);
      provider.receive(conversion.conversionId, overrides);
      const response = await reconcile(customer, conversion.conversionId);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        conversionStatus: 'exception',
        exceptionCode,
        operationId: null,
        nextAction: 'contact_support',
      });
      provider.receive(conversion.conversionId);
      expect(
        (await reconcile(customer, conversion.conversionId)).json()
          .exceptionCode,
      ).toBe(exceptionCode);
      expect(await balance(customer)).toBe(0n);
    },
  );
  it('separates pending, timely receipt found late and actual late receipt', async () => {
    const app = await createConversionApplication([
      route({ offers: [{ ...offer, transferWindowSeconds: 1 }] }),
    ]);
    const timelyOwner = await createFundingCustomer(app, database);
    const lateOwner = await createFundingCustomer(app, database);
    const pendingOwner = await createFundingCustomer(app, database);
    const timely = await pending(timelyOwner, app);
    const late = await pending(lateOwner, app);
    const waiting = await pending(pendingOwner, app);
    provider.receive(timely.conversionId);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    provider.receive(late.conversionId);
    expect(
      (await reconcile(timelyOwner, timely.conversionId, app)).json()
        .conversionStatus,
    ).toBe('credited');
    expect(
      (await reconcile(lateOwner, late.conversionId, app)).json(),
    ).toMatchObject({
      conversionStatus: 'exception',
      exceptionCode: 'late_receipt',
      nextAction: 'contact_support',
    });
    expect(
      (await reconcile(pendingOwner, waiting.conversionId, app)).json(),
    ).toMatchObject({
      conversionStatus: 'verification_pending',
      exceptionCode: null,
    });
    expect(await balance(timelyOwner, app)).toBe(78900n);
    expect(await balance(lateOwner, app)).toBe(0n);
    expect(await balance(pendingOwner, app)).toBe(0n);
  });
  it('retains confirmed verification failure with a safe next action', async () => {
    const customer = await createFundingCustomer(application, database);
    const conversion = await pending(customer);
    const prior = provider.replies.get(conversion.conversionId)!;
    provider.replies.set(conversion.conversionId, {
      ...prior,
      receiptStatus: 'verification_failed',
      evidenceReference: `failure:${randomUUID()}`,
    });
    expect(
      (await reconcile(customer, conversion.conversionId)).json(),
    ).toMatchObject({
      conversionStatus: 'exception',
      exceptionCode: 'verification_failed',
      nextAction: 'contact_support',
    });
    expect(await balance(customer)).toBe(0n);
  });
  it('keeps duplicate economic receipts in exception without crediting another wallet', async () => {
    const firstOwner = await createFundingCustomer(application, database);
    const secondOwner = await createFundingCustomer(application, database);
    const first = await pending(firstOwner);
    const second = await pending(secondOwner);
    const receipt = provider.receive(first.conversionId);
    expect(
      (await reconcile(firstOwner, first.conversionId)).json().conversionStatus,
    ).toBe('credited');
    provider.receive(second.conversionId, {
      externalMovementId: receipt.externalMovementId,
    });
    expect(
      (await reconcile(secondOwner, second.conversionId)).json(),
    ).toMatchObject({
      conversionStatus: 'exception',
      exceptionCode: 'movement_conflict',
    });
    expect(await balance(firstOwner)).toBe(78900n);
    expect(await balance(secondOwner)).toBe(0n);
  });
  it('preserves verified proof on credit failure and recovers after adapter removal', async () => {
    const customer = await createFundingCustomer(application, database);
    const conversion = await pending(customer);
    provider.receive(conversion.conversionId);
    await database.administrator
      .updateTable('wallets')
      .set({ wallet_status: 'closed' })
      .where('id', '=', customer.walletId)
      .execute();
    expect(
      (await reconcile(customer, conversion.conversionId)).statusCode,
    ).toBe(409);
    const read = await application.inject({
      method: 'GET',
      url: `/v1/airtime-conversions/${conversion.conversionId}`,
      headers: authorization(customer),
    });
    expect(read.json()).toMatchObject({
      conversionStatus: 'credit_pending',
      receivedAt: expect.any(String),
      operationId: null,
    });
    await database.administrator
      .updateTable('wallets')
      .set({ wallet_status: 'frozen' })
      .where('id', '=', customer.walletId)
      .execute();
    const noAdapter = await createConversionApplication();
    const inspections = provider.inspections.length;
    expect(
      (await reconcile(customer, conversion.conversionId, noAdapter)).json()
        .conversionStatus,
    ).toBe('credited');
    expect(provider.inspections.length).toBe(inspections);
    expect(await balance(customer, noAdapter)).toBe(78900n);
  });
  it('never attaches an existing funding journal with the same movement and matching amount to a conversion', async () => {
    const customer = await createFundingCustomer(application, database);
    const conversion = await pending(customer);
    const receipt = provider.receive(conversion.conversionId);
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ validate: validateEnvironment }),
        WalletModule.register({
          funding: {
            verifyFunding: async () => ({
              walletId: customer.walletId,
              partnerAccountId,
              externalMovementId: receipt.externalMovementId,
              evidenceReference: 'different-funding-proof',
              value: money(78900n, 'NGN'),
            }),
          },
          paymentOutcome: {
            verifyOutcome: async () => ({
              outcome: 'unknown',
              paymentReference: 'unused',
            }),
          },
        }),
      ],
    })
      .overrideProvider(DatabaseConnection)
      .useValue({ database: database.database })
      .compile();
    try {
      await module
        .get(WalletService)
        .confirmWalletFunding('different-funding-proof');
    } finally {
      await module.close();
    }
    expect(
      (await reconcile(customer, conversion.conversionId)).statusCode,
    ).toBe(409);
    const read = await application.inject({
      method: 'GET',
      url: `/v1/airtime-conversions/${conversion.conversionId}`,
      headers: authorization(customer),
    });
    expect(read.json()).toMatchObject({
      conversionStatus: 'exception',
      exceptionCode: 'movement_conflict',
      operationId: null,
    });
    expect(await balance(customer)).toBe(78900n);
  });
});

describe('airtime conversion authorization and terms', () => {
  it('fails closed without configuration and never invents eligible networks', async () => {
    const app = await createConversionApplication();
    const customer = await createFundingCustomer(app, database);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/wallets/${customer.walletId}/airtime-conversion-offers`,
          headers: authorization(customer),
        })
      ).json(),
    ).toEqual([]);
    expect((await quote(customer, {}, app)).statusCode).toBe(422);
  });
  it('filters offers by the authoritative wallet currency', async () => {
    const customer = await createFundingCustomer(application, database, 'USD');
    expect(
      (
        await application.inject({
          method: 'GET',
          url: `/v1/wallets/${customer.walletId}/airtime-conversion-offers`,
          headers: authorization(customer),
        })
      ).json(),
    ).toEqual([]);
    expect((await quote(customer)).statusCode).toBe(422);
  });
  it('rejects ineligible sources and validates amount limits before provider checks', async () => {
    const customer = await createFundingCustomer(application, database);
    provider.isEligible = false;
    expect((await quote(customer)).json().code).toBe('AIRTIME_INELIGIBLE');
    provider.isEligible = true;
    const calls = provider.eligibilityInputs.length;
    for (const amount of ['999', '1000001', '1001']) {
      expect(
        (await quote(customer, { airtimeMinorUnits: amount })).statusCode,
      ).toBe(422);
    }
    expect(provider.eligibilityInputs.length).toBe(calls);
  });
  it('expires quotes at source eligibility validity and requires fresh review before acceptance', async () => {
    const customer = await createFundingCustomer(application, database);
    provider.eligibilityValidityMs = 500;
    const review = await quote(customer);
    expect(review.statusCode).toBe(201);
    expect(
      new Date(review.json().expiresAt).getTime() -
        new Date(review.json().quotedAt).getTime(),
    ).toBeLessThan(1000);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await accept(customer, review.json().quoteId)).json().code).toBe(
      'QUOTE_EXPIRED',
    );
  });
  it('requires renewed consent when terms change, while accepted work retains original terms after withdrawal', async () => {
    const customer = await createFundingCustomer(application, database);
    const reviewed = await quote(customer);
    const accepted = await pending(customer);
    const changed = await createConversionApplication([
      route({
        offers: [
          { ...offer, fixedFeeMinorUnits: 200n, termsVersion: 'test-v2' },
        ],
      }),
    ]);
    expect(
      (
        await accept(customer, reviewed.json().quoteId, randomUUID(), changed)
      ).json().code,
    ).toBe('CONVERSION_TERMS_CHANGED');
    const withdrawn = await createConversionApplication([
      route({ acceptsNewRequests: false, offers: [] }),
    ]);
    provider.receive(accepted.conversionId);
    const credited = await reconcile(
      customer,
      accepted.conversionId,
      withdrawn,
    );
    expect(credited.json()).toMatchObject({
      conversionStatus: 'credited',
      quote: {
        netCreditMinorUnits: '78900',
        offer: { termsVersion: 'test-v1' },
      },
    });
    expect(
      (
        await accept(
          customer,
          accepted.quote.quoteId,
          accepted.requestKey,
          withdrawn,
        )
      ).json().operationId,
    ).toBe(credited.json().operationId);
  });
  it('does not substitute a new realm or clearing account during recovery', async () => {
    const customer = await createFundingCustomer(application, database);
    const conversion = await pending(customer);
    const app = await createConversionApplication([
      route({
        providerId: 'replacement-realm',
        partnerAccountId: replacementAccountId,
      }),
    ]);
    const calls = provider.inspections.length;
    expect(
      (await reconcile(customer, conversion.conversionId, app)).json().code,
    ).toBe('CONVERSION_UNAVAILABLE');
    expect(provider.inspections.length).toBe(calls);
    expect(await balance(customer)).toBe(0n);
  });
  it('rejects foreign wallets, quotes, conversions and keys before external work', async () => {
    const owner = await createFundingCustomer(application, database);
    const intruder = await createFundingCustomer(application, database);
    const conversion = await pending(owner);
    const checks = provider.eligibilityInputs.length;
    const inspections = provider.inspections.length;
    expect(
      (await quote(intruder, { walletId: owner.walletId })).statusCode,
    ).toBe(404);
    expect(
      (
        await application.inject({
          method: 'GET',
          url: `/v1/wallets/${owner.walletId}/airtime-conversion-offers`,
          headers: authorization(intruder),
        })
      ).statusCode,
    ).toBe(404);
    expect((await accept(intruder, conversion.quote.quoteId)).statusCode).toBe(
      404,
    );
    for (const url of [
      `/v1/airtime-conversions/quotes/${conversion.quote.quoteId}`,
      `/v1/airtime-conversions/${conversion.conversionId}`,
      `/v1/airtime-conversions/by-request-key?requestKey=${conversion.requestKey}`,
    ]) {
      expect(
        (
          await application.inject({
            method: 'GET',
            url,
            headers: authorization(intruder),
          })
        ).statusCode,
      ).toBe(404);
    }
    expect(
      (await reconcile(intruder, conversion.conversionId)).statusCode,
    ).toBe(404);
    expect(provider.eligibilityInputs.length).toBe(checks);
    expect(provider.inspections.length).toBe(inspections);
  });
  it('denies new work for a closed wallet and permits a frozen wallet to receive verified credit', async () => {
    const customer = await createFundingCustomer(application, database);
    const reviewed = await quote(customer);
    await database.administrator
      .updateTable('wallets')
      .set({ wallet_status: 'closed' })
      .where('id', '=', customer.walletId)
      .execute();
    expect((await quote(customer)).statusCode).toBe(409);
    expect((await accept(customer, reviewed.json().quoteId)).statusCode).toBe(
      409,
    );
    await database.administrator
      .updateTable('wallets')
      .set({ wallet_status: 'frozen' })
      .where('id', '=', customer.walletId)
      .execute();
    const conversion = await pending(customer);
    provider.receive(conversion.conversionId);
    expect(
      (await reconcile(customer, conversion.conversionId)).json()
        .conversionStatus,
    ).toBe('credited');
  });
  it.each([
    { airtimeMinorUnits: 100000 },
    { airtimeMinorUnits: '1e5' },
    { airtimeMinorUnits: '1000.5' },
    { airtimeMinorUnits: '-1' },
    { airtimeMinorUnits: '0' },
    { airtimeMinorUnits: '01000' },
    { airtimeMinorUnits: '100000\n' },
    { airtimeMinorUnits: '9223372036854775808' },
    { airtimeMinorUnits: null },
    { sourcePhoneNumber: 2348012345678 },
    { sourcePhoneNumber: '+2348012345678\n' },
    { sourcePhoneNumber: '08012345678' },
    { sourcePhoneNumber: null },
    { offerId: [offer.id] },
    { ownerId: randomUUID() },
    { netCreditMinorUnits: '9999999' },
    { currency: 'USD' },
    { partnerAccountId },
    { isSuccessful: true },
  ])('rejects malformed or over-posted quote %j', async (overrides) => {
    const customer = await createFundingCustomer(application, database);
    const calls = provider.eligibilityInputs.length;
    const response = await quote(customer, overrides);
    expect(response.statusCode).toBe(400);
    expect(provider.eligibilityInputs.length).toBe(calls);
    expect(await balance(customer)).toBe(0n);
  });
  it('rejects client receipt/success claims and unknown query fields', async () => {
    const customer = await createFundingCustomer(application, database);
    const conversion = await pending(customer);
    const calls = provider.inspections.length;
    const assertion = await application.inject({
      method: 'POST',
      url: `/v1/airtime-conversions/${conversion.conversionId}/reconcile`,
      headers: authorization(customer),
      payload: {
        airtimeSent: true,
        evidenceReference: 'client-assertion',
        externalMovementId: 'fake',
        isSuccessful: true,
      },
    });
    expect(assertion.statusCode).toBe(400);
    expect(provider.inspections.length).toBe(calls);
    const overposted = await application.inject({
      method: 'POST',
      url: '/v1/airtime-conversions',
      headers: authorization(customer),
      payload: {
        quoteId: conversion.quote.quoteId,
        requestKey: conversion.requestKey,
        netCreditMinorUnits: '1000000',
      },
    });
    expect(overposted.statusCode).toBe(400);
    expect(
      (
        await application.inject({
          method: 'GET',
          url: '/v1/airtime-conversions/by-request-key?requestKey=owned&ownerId=other',
          headers: authorization(customer),
        })
      ).statusCode,
    ).toBe(400);
    expect(await balance(customer)).toBe(0n);
  });
  it('does not expose provider bindings, receipt identities or internal correlation in successful responses', async () => {
    const customer = await createFundingCustomer(application, database);
    const conversion = await pending(customer);
    const receipt = provider.receive(conversion.conversionId);
    const response = await reconcile(customer, conversion.conversionId);
    for (const secret of [
      partnerAccountId,
      receipt.externalMovementId,
      receipt.evidenceReference,
      receipt.requestFingerprint,
      'test-conversion-realm',
      offer.providerProductCode,
    ]) {
      expect(response.body).not.toContain(secret);
    }
    expect(response.json().operationId).toBeTruthy();
  });
});

describe('airtime conversion storage boundaries', () => {
  it('protects immutable terms, destinations, acceptance and proof under the restricted runtime role', async () => {
    const customer = await createFundingCustomer(application, database);
    const conversion = await pending(customer);
    provider.receive(conversion.conversionId);
    expect(
      (await reconcile(customer, conversion.conversionId)).statusCode,
    ).toBe(200);
    await expect(
      database.database
        .updateTable('airtime_conversion_quotes')
        .set({ net_credit_minor_units: 1n })
        .where('id', '=', conversion.quote.quoteId)
        .execute(),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      database.database
        .deleteFrom('airtime_conversions')
        .where('id', '=', conversion.conversionId)
        .execute(),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      database.database
        .updateTable('airtime_conversions')
        .set({ initialization_started_at: new Date() })
        .where('id', '=', conversion.conversionId)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database.administrator
        .updateTable('airtime_conversion_quotes')
        .set({ source_phone_number: '+2348000000000' })
        .where('id', '=', conversion.quote.quoteId)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database.administrator
        .updateTable('airtime_conversion_instructions')
        .set({ receiving_phone_number: '+2348000000000' })
        .where('conversion_id', '=', conversion.conversionId)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database.administrator
        .deleteFrom('airtime_conversion_outcomes')
        .where('conversion_id', '=', conversion.conversionId)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('rejects a forged verified SQL receipt that differs from accepted monetary terms', async () => {
    const customer = await createFundingCustomer(application, database);
    const conversion = await pending(customer);
    const receipt = provider.receive(conversion.conversionId, {
      netCreditValue: money(1n, 'NGN'),
    });
    const serializableReceipt = JSON.parse(
      JSON.stringify(receipt, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    );
    await expect(
      database.database
        .insertInto('airtime_conversion_outcomes')
        .values({
          conversion_id: conversion.conversionId,
          partner_account_id: partnerAccountId,
          outcome: 'verified',
          exception_code: null,
          external_movement_id: receipt.externalMovementId,
          evidence_reference: receipt.evidenceReference,
          received_at: receipt.receivedAt,
          observed_airtime_minor_units: 100000n,
          observed_currency: 'NGN',
          receipt_fingerprint: JSON.stringify(serializableReceipt),
          receipt: serializableReceipt,
        })
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await balance(customer)).toBe(0n);
  });
});
