/** Exercise AxiaPay funding contracts against real PostgreSQL, with no external provider modules or protocols. */
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
import { DatabaseConnection } from '../../src/infrastructure/database/database.module.js';
import { WalletHttpModule } from '../../src/modules/wallets/wallet-http.module.js';
import { WalletFundingModule } from '../../src/modules/wallet-funding/wallet-funding.module.js';
import { WalletFundingService } from '../../src/modules/wallet-funding/services/wallet-funding.service.js';
import {
  FundingError,
  type VerifiedFundingPayment,
} from '../../src/modules/wallet-funding/domain/funding.js';
import type {
  FundingAdapter,
  FundingCheckoutRequest,
  FundingRoute,
  AuthenticatedFundingNotification,
} from '../../src/modules/wallet-funding/ports/funding-adapter.js';
import {
  startWalletTestDatabase,
  type WalletTestDatabase,
} from '../support/wallet-test-database.js';
import {
  createFundingCustomer,
  type FundingCustomer,
} from '../support/funding-test-customer.js';

/** Test-only implementation of the owned outbound port. It is never imported or configured by a runtime module. */
class ContractFundingAdapter implements FundingAdapter {
  readonly environment = 'test';
  readonly requests: FundingCheckoutRequest[] = [];
  readonly payments = new Map<string, VerifiedFundingPayment>();
  loseInitializationResponse = false;
  verificationUnavailable = false;
  checkoutUrl = 'https://checkout.example/continue';

  /** Bind a distinct fixture clearing account; no real credentials or HTTP clients are used. */
  constructor(readonly partnerAccountId = randomUUID()) {}

  /** Accept an order before optionally losing its response, reproducing submission uncertainty. */
  async initialize(request: FundingCheckoutRequest): Promise<string> {
    this.requests.push(request);
    this.payments.set(request.reference, {
      reference: request.reference,
      externalMovementId: `collection:${randomUUID()}`,
      value: request.value,
      isSuccessful: false,
    });
    if (this.loseInitializationResponse) {
      throw new FundingError('FUNDING_UNAVAILABLE');
    }
    return this.checkoutUrl;
  }

  /** Return controlled canonical evidence independently of any notification; unavailable never implies failed payment. */
  async verify(reference: string): Promise<VerifiedFundingPayment> {
    if (this.verificationUnavailable) {
      throw new FundingError('FUNDING_UNAVAILABLE');
    }
    const payment = this.payments.get(reference);
    if (!payment) {
      throw new FundingError('FUNDING_UNCONFIRMED');
    }
    return payment;
  }
}

let database: WalletTestDatabase;
let application: NestFastifyApplication;
const applications: NestFastifyApplication[] = [];
const adapter = new ContractFundingAdapter();
const replacement = new ContractFundingAdapter();

/** One independently configurable AxiaPay option; arbitrary adapter IDs require no domain, DTO or schema edits. */
function route(overrides: Partial<FundingRoute> = {}): FundingRoute {
  return {
    adapterId: 'primary-collection',
    adapter,
    acceptsNewRequests: true,
    option: {
      id: 'hosted-checkout',
      displayName: 'Hosted checkout',
      currency: 'NGN',
      minimumAmountMinorUnits: 100n,
      maximumAmountMinorUnits: 1000000n,
    },
    ...overrides,
  };
}

/** Compose the actual core module directly, deliberately excluding the application's optional provider integration module. */
async function coreApplication(
  routes?: readonly FundingRoute[],
): Promise<NestFastifyApplication> {
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ validate: validateEnvironment }),
      RequestValidationModule,
      WalletHttpModule,
      WalletFundingModule.register(
        routes ? { routes: { useValue: routes } } : {},
      ),
    ],
  })
    .overrideProvider(DatabaseConnection)
    .useValue({ database: database.database })
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
  await sql`select grant_funding_runtime_access('wallet_runtime'); grant select on auth_accounts, auth_sessions to wallet_runtime`.execute(
    database.administrator,
  );
  await database.administrator
    .insertInto('ledger_accounts')
    .values(
      [adapter, replacement].map((capability) => ({
        id: capability.partnerAccountId,
        account_code: `test:${capability.partnerAccountId}`,
        account_kind: 'partner_funds',
        currency: 'NGN',
        wallet_id: null,
      })),
    )
    .execute();
  application = await coreApplication([route()]);
});
beforeEach(() => {
  adapter.loseInitializationResponse = false;
  adapter.verificationUnavailable = false;
  adapter.checkoutUrl = 'https://checkout.example/continue';
});
afterAll(async () => {
  await Promise.all(applications.map((app) => app.close()));
  await database?.stop();
});

/** Submit only public owned-contract terms with a real session. */
function initialize(
  owner: FundingCustomer,
  overrides: Record<string, unknown> = {},
  app = application,
) {
  return app.inject({
    method: 'POST',
    url: `/v1/wallets/${owner.walletId}/funding-requests`,
    headers: { authorization: `Bearer ${owner.token}` },
    payload: {
      fundingOptionId: 'hosted-checkout',
      currency: 'NGN',
      amountMinorUnits: '10000',
      payerEmail: 'payer@example.com',
      requestKey: randomUUID(),
      ...overrides,
    },
  });
}

/** Read available options through authorization and serialization, never directly from configuration. */
function discover(owner: FundingCustomer, app = application) {
  return app.inject({
    method: 'GET',
    url: `/v1/wallets/${owner.walletId}/funding-options`,
    headers: { authorization: `Bearer ${owner.token}` },
  });
}

/** Recover using the server's saved intent; caller supplies no success or amount claims. */
function reconcile(
  owner: FundingCustomer,
  fundingId: string,
  app = application,
) {
  return app.inject({
    method: 'POST',
    url: `/v1/wallet-funding/${fundingId}/reconcile`,
    headers: { authorization: `Bearer ${owner.token}` },
  });
}

/** Assemble trusted input as an authenticated delivery adapter would, separate from customer HTTP input. */
function notification(fundingId: string): AuthenticatedFundingNotification {
  return {
    adapterId: 'primary-collection',
    environment: 'test',
    partnerAccountId: adapter.partnerAccountId,
    reference: fundingId,
    externalMovementId: adapter.payments.get(fundingId)!.externalMovementId,
  };
}

/** Assert authoritative money through the customer contract. */
async function balance(owner: FundingCustomer): Promise<string> {
  const response = await application.inject({
    method: 'GET',
    url: `/v1/wallets/${owner.walletId}/balance`,
    headers: { authorization: `Bearer ${owner.token}` },
  });
  expect(response.statusCode).toBe(200);
  return response.json().availableMinorUnits;
}

describe('provider-neutral funding contracts', () => {
  it('boots with no adapters, authenticates discovery, and fails closed without manufacturing checkout or credit', async () => {
    const app = await coreApplication();
    const owner = await createFundingCustomer(app, database);
    expect((await discover(owner, app)).json()).toEqual([]);
    expect((await initialize(owner, {}, app)).statusCode).toBe(503);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/wallets/${owner.walletId}/funding-options`,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/webhooks/wallet-funding/paystack',
        })
      ).statusCode,
    ).toBe(404);
    const records = await database.database
      .selectFrom('wallet_funding_requests')
      .select('id')
      .where('owner_id', '=', owner.actorId)
      .execute();
    expect(records).toEqual([]);
    expect(await balance(owner)).toBe('0');
  });

  it('publishes exact option limits for the owned currency and rejects routing/identity injection before submission', async () => {
    const owner = await createFundingCustomer(application, database);
    const other = await createFundingCustomer(application, database);
    const usd = await createFundingCustomer(application, database, 'USD');
    const options = await discover(owner);
    expect(options.headers['cache-control']).toBe('no-store');
    expect(options.json()).toEqual([
      {
        id: 'hosted-checkout',
        displayName: 'Hosted checkout',
        currency: 'NGN',
        minimumAmountMinorUnits: '100',
        maximumAmountMinorUnits: '1000000',
      },
    ]);
    expect((await discover({ ...owner, token: other.token })).statusCode).toBe(
      404,
    );
    expect((await discover(usd)).json()).toEqual([]);
    const calls = adapter.requests.length;
    for (const overrides of [
      { amountMinorUnits: '99' },
      { amountMinorUnits: '1000001' },
      { partner: 'paystack' },
      { adapterId: 'injected' },
      { partnerAccountId: randomUUID() },
      { fundingOptionId: 'hosted-checkout\n' },
      { amountMinorUnits: 10000 },
    ]) {
      expect((await initialize(owner, overrides)).statusCode).toBe(400);
    }
    expect(
      (await initialize(owner, { fundingOptionId: 'missing-option' }))
        .statusCode,
    ).toBe(503);
    expect(adapter.requests).toHaveLength(calls);
  });

  it('persists and credits arbitrary adapters once under concurrent creation, notifications, and reconciliation', async () => {
    const owner = await createFundingCustomer(application, database);
    const requestKey = randomUUID();
    const calls = adapter.requests.length;
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => initialize(owner, { requestKey })),
    );
    expect(responses.every((response) => response.statusCode === 202)).toBe(
      true,
    );
    const fundingId = responses[0]!.json().fundingId as string;
    expect(
      new Set(responses.map((response) => response.json().fundingId)).size,
    ).toBe(1);
    expect(adapter.requests).toHaveLength(calls + 1);
    expect(Object.keys(adapter.requests.at(-1)!)).toEqual([
      'reference',
      'value',
      'payerEmail',
    ]);
    expect(responses[0]!.json()).not.toHaveProperty('adapterId');
    expect(responses[0]!.json()).not.toHaveProperty('partner');
    expect(
      (await initialize(owner, { requestKey, amountMinorUnits: '10001' }))
        .statusCode,
    ).toBe(409);
    adapter.payments.set(fundingId, {
      ...adapter.payments.get(fundingId)!,
      isSuccessful: true,
    });
    const coordinator = application.get(WalletFundingService);
    await Promise.all(
      Array.from({ length: 6 }, () =>
        coordinator.receiveNotification(notification(fundingId)),
      ),
    );
    const reconciled = await Promise.all(
      Array.from({ length: 4 }, () => reconcile(owner, fundingId)),
    );
    expect(reconciled.every((response) => response.statusCode === 200)).toBe(
      true,
    );
    expect(
      new Set(reconciled.map((response) => response.json().operationId)).size,
    ).toBe(1);
    expect(await balance(owner)).toBe('10000');
    adapter.verificationUnavailable = true;
    await expect(
      coordinator.receiveNotification(notification(fundingId)),
    ).resolves.toBeUndefined();
    expect((await reconcile(owner, fundingId)).statusCode).toBe(200);
    adapter.verificationUnavailable = false;
    const duplicateId = (await initialize(owner)).json().fundingId as string;
    adapter.payments.set(duplicateId, {
      ...adapter.payments.get(fundingId)!,
      reference: duplicateId,
    });
    expect((await reconcile(owner, duplicateId)).statusCode).toBe(409);
    expect(await balance(owner)).toBe('10000');
  });

  it('checks notification binding and independently verified reference, currency, amount and success', async () => {
    const owner = await createFundingCustomer(application, database);
    const fundingId = (await initialize(owner)).json().fundingId as string;
    const coordinator = application.get(WalletFundingService);
    for (const fields of [
      { adapterId: 'other-collection' },
      { partnerAccountId: replacement.partnerAccountId },
      { environment: 'live' as const },
    ]) {
      await expect(
        coordinator.receiveNotification({
          ...notification(fundingId),
          ...fields,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_WEBHOOK' });
    }
    const payment = { ...adapter.payments.get(fundingId)!, isSuccessful: true };
    for (const fields of [
      { reference: randomUUID() },
      { value: { ...payment.value, currency: 'USD' } },
      { value: { ...payment.value, amountMinorUnits: 10001n } },
    ]) {
      adapter.payments.set(fundingId, { ...payment, ...fields });
      expect((await reconcile(owner, fundingId)).statusCode).toBe(400);
    }
    adapter.payments.set(fundingId, { ...payment, isSuccessful: false });
    expect((await reconcile(owner, fundingId)).statusCode).toBe(409);
    expect(await balance(owner)).toBe('0');
    adapter.payments.set(fundingId, payment);
    await expect(
      coordinator.receiveNotification({
        ...notification(fundingId),
        externalMovementId: 'another:movement',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_FUNDING' });
    expect((await reconcile(owner, fundingId)).statusCode).toBe(200);
  });

  it('withdraws an option from new requests while retaining accepted intent and reconciliation', async () => {
    const owner = await createFundingCustomer(application, database);
    const requestKey = randomUUID();
    const fundingId = (await initialize(owner, { requestKey })).json()
      .fundingId as string;
    const withdrawn = await coreApplication([
      route({ acceptsNewRequests: false }),
    ]);
    expect((await discover(owner, withdrawn)).json()).toEqual([]);
    expect((await initialize(owner, {}, withdrawn)).statusCode).toBe(503);
    const calls = adapter.requests.length;
    expect(
      (await initialize(owner, { requestKey }, withdrawn)).json().fundingId,
    ).toBe(fundingId);
    expect(adapter.requests).toHaveLength(calls);
    adapter.payments.set(fundingId, {
      ...adapter.payments.get(fundingId)!,
      isSuccessful: true,
    });
    expect((await reconcile(owner, fundingId, withdrawn)).statusCode).toBe(200);
    expect(await balance(owner)).toBe('10000');
  });

  it('never rebinds an accepted request when the same public option switches to another adapter', async () => {
    const owner = await createFundingCustomer(application, database);
    const requestKey = randomUUID();
    const fundingId = (await initialize(owner, { requestKey })).json()
      .fundingId as string;
    const switched = await coreApplication([
      route({ adapterId: 'replacement-collection', adapter: replacement }),
    ]);
    expect(
      (await initialize(owner, { requestKey }, switched)).json().fundingId,
    ).toBe(fundingId);
    expect((await reconcile(owner, fundingId, switched)).statusCode).toBe(503);
    expect(replacement.requests).toHaveLength(0);
    const saved = await database.database
      .selectFrom('wallet_funding_requests')
      .select(['partner', 'partner_account_id'])
      .where('id', '=', fundingId)
      .executeTakeFirstOrThrow();
    expect(saved).toEqual({
      partner: 'primary-collection',
      partner_account_id: adapter.partnerAccountId,
    });
    expect(await balance(owner)).toBe('0');
  });

  it('recovers uncertain submission and verification with the same identity and no second checkout', async () => {
    const owner = await createFundingCustomer(application, database);
    const requestKey = randomUUID();
    adapter.loseInitializationResponse = true;
    const calls = adapter.requests.length;
    expect((await initialize(owner, { requestKey })).statusCode).toBe(503);
    const retry = (await initialize(owner, { requestKey })).json();
    expect(retry.checkoutUrl).toBeNull();
    expect(retry.fundingStatus).toBe('pending');
    expect(adapter.requests).toHaveLength(calls + 1);
    adapter.payments.set(retry.fundingId, {
      ...adapter.payments.get(retry.fundingId)!,
      isSuccessful: true,
    });
    adapter.verificationUnavailable = true;
    expect((await reconcile(owner, retry.fundingId)).statusCode).toBe(503);
    expect(await balance(owner)).toBe('0');
    adapter.verificationUnavailable = false;
    expect((await reconcile(owner, retry.fundingId)).statusCode).toBe(200);
    expect(await balance(owner)).toBe('10000');
  });

  it('rejects an adapter that violates the public HTTPS redirect contract without crediting or resubmitting', async () => {
    const owner = await createFundingCustomer(application, database);
    const requestKey = randomUUID();
    adapter.checkoutUrl = 'javascript:alert(1)';
    const calls = adapter.requests.length;
    expect((await initialize(owner, { requestKey })).statusCode).toBe(400);
    expect(
      (await initialize(owner, { requestKey })).json().checkoutUrl,
    ).toBeNull();
    expect(adapter.requests).toHaveLength(calls + 1);
    expect(await balance(owner)).toBe('0');
  });
});
