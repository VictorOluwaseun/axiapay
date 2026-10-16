import { WalletSummaryInvalidationConnection } from '../../src/infrastructure/database/wallet-summary-invalidation.connection.js';
import { SessionCacheInvalidationConnection } from '../../src/infrastructure/database/session-cache-invalidation.connection.js';
import type { AxiosAdapter, AxiosHeaders, AxiosResponse } from 'axios';
import { axiosTextResponse } from '../../../../packages/payments-runtime/tests/support/axios-response-fixture.js';
/** Exercise real partner adapters, signed HTTP callbacks, session guards, and restricted PostgreSQL posting without live payments. */
import { createHmac, randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { sql } from 'kysely';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { ApiModule } from '../../src/bootstrap/api.module.js';
import { DatabaseConnection } from '@axiapay/payments-runtime/infrastructure/database/database.module';
import {
  createFundingCustomer,
  type FundingCustomer,
} from '../support/funding-test-customer.js';
import { PROVIDER_FUNDING } from '../../src/modules/wallet-funding/adapters/provider-funding.module.js';
import { PaystackFundingGateway } from '../../src/modules/wallet-funding/adapters/paystack-funding.gateway.js';
import { OpayFundingGateway } from '../../src/modules/wallet-funding/adapters/opay-funding.gateway.js';
import { WalletFundingService } from '../../src/modules/wallet-funding/services/wallet-funding.service.js';
import { WalletModule } from '@axiapay/payments-runtime/modules/wallets/wallet.module';
import { WalletService } from '@axiapay/payments-runtime/modules/wallets/services/wallet.service';
import { money } from '@axiapay/payments-runtime/modules/wallets/domain/money';
/** Provider fixture names are local to adapter conformance tests, never part of the core contract. */
type FundingPartner = 'opay' | 'paystack';
import type { FundingResponseDto } from '../../src/modules/wallet-funding/dtos/funding.dto.js';
import {
  startWalletTestDatabase,
  type WalletTestDatabase,
} from '../../../../packages/payments-runtime/tests/support/wallet-test-database.js';

const paystackSecret = 'sk_test_localfixture';
const opaySecret = 'OPAYPRV-local-fixture-secret';
const merchantId = '256612345678901';
const ledgerAccounts = { paystack: randomUUID(), opay: randomUUID() };

/** Controlled remote order; altering verification terms models inconsistent or malicious provider evidence. */
interface RemoteOrder {
  partner: FundingPartner;
  reference: string;
  movementId: string;
  amount: string;
  currency: string;
  status: string;
  environment: string;
  voided: boolean;
}

/** Simulate only HTTP transport; production request signing, response parsing, and business verification remain active. */
class PartnerTransport {
  readonly orders = new Map<string, RemoteOrder>();
  initializationCalls = 0;
  verificationCalls = 0;
  loseInitializationResponse = false;
  rejectVerification = false;

  /** Validate adapter credentials and route the fixed provider requests to controlled response fixtures. */
  send: AxiosAdapter = async (config) => {
    const url = config.url!;
    const partner = url.includes('paystack.co') ? 'paystack' : 'opay';
    const headers = config.headers;
    const body = config.data ? JSON.parse(String(config.data)) : {};
    if (url.endsWith('/initialize') || url.endsWith('/create')) {
      return this.initialize(partner, body, headers);
    }
    const reference =
      partner === 'paystack'
        ? decodeURIComponent(url.split('/').at(-1)!)
        : body.reference;
    const authorization =
      partner === 'paystack'
        ? paystackSecret
        : createHmac('sha512', opaySecret)
            .update(String(config.data))
            .digest('hex');
    expect(headers.get('authorization')).toBe(`Bearer ${authorization}`);
    if (partner === 'opay') {
      expect(headers.get('merchantid')).toBe(merchantId);
    }
    return this.verify(reference);
  };

  /** Create an order before optionally losing its response, reproducing the dangerous ambiguous initialization case. */
  private initialize(
    partner: FundingPartner,
    body: Record<string, unknown>,
    headers: AxiosHeaders,
  ): AxiosResponse<string> {
    this.initializationCalls += 1;
    expect(headers.get('authorization')).toBe(
      `Bearer ${partner === 'paystack' ? paystackSecret : 'OPAYPUB-local-fixture'}`,
    );
    const reference = String(body.reference);
    const amount =
      partner === 'paystack'
        ? String(body.amount)
        : String((body.amount as { total: number }).total);
    const currency =
      partner === 'paystack'
        ? String(body.currency)
        : String((body.amount as { currency: string }).currency);
    this.orders.set(reference, {
      partner,
      reference,
      amount,
      currency,
      movementId: String(
        (partner === 'opay' ? 220507145660712931829n : 9007199254740993n) +
          BigInt(this.orders.size),
      ),
      status: 'pending',
      environment: 'test',
      voided: false,
    });
    if (this.loseInitializationResponse) {
      throw new Error('simulated connection lost after order creation');
    }
    const data =
      partner === 'paystack'
        ? {
            reference,
            authorization_url: `https://checkout.paystack.com/${reference}`,
          }
        : {
            reference,
            amount: { total: Number(amount), currency },
            cashierUrl: `https://sandboxcashier.opaycheckout.com/checkout/${reference}`,
          };
    return axiosTextResponse(
      JSON.stringify(
        partner === 'paystack'
          ? { status: true, data }
          : { code: '00000', data },
      ),
    );
  }

  /** Return authoritative partner status separately from notification claims. */
  private verify(reference: string): AxiosResponse<string> {
    this.verificationCalls += 1;
    if (this.rejectVerification) {
      return axiosTextResponse('unavailable', 503);
    }
    const order = this.orders.get(reference);
    if (!order) {
      return axiosTextResponse('missing', 404);
    }
    if (order.partner === 'paystack') {
      return axiosTextResponse(
        JSON.stringify({
          status: true,
          data: {
            id: order.movementId,
            reference: order.reference,
            amount: order.amount,
            currency: order.currency,
            status: order.status === 'success' ? 'success' : order.status,
            domain: order.environment,
          },
        }),
      );
    }
    return axiosTextResponse(
      JSON.stringify({
        code: '00000',
        data: {
          orderNo: order.movementId,
          reference: order.reference,
          amount: { total: order.amount, currency: order.currency },
          status: order.status === 'success' ? 'SUCCESS' : 'PENDING',
          isVoided: order.voided,
        },
      }),
    );
  }
}

let database: WalletTestDatabase;
let application: NestFastifyApplication;
const transport = new PartnerTransport();

beforeAll(async () => {
  database = await startWalletTestDatabase();
  await sql`select grant_funding_runtime_access('wallet_runtime'); grant select on auth_accounts, auth_sessions to wallet_runtime`.execute(
    database.administrator,
  );
  await database.administrator
    .insertInto('ledger_accounts')
    .values(
      Object.entries(ledgerAccounts).map(([partner, id]) => ({
        id,
        account_code: `test:${partner}`,
        account_kind: 'partner_funds',
        currency: 'NGN',
        wallet_id: null,
      })),
    )
    .execute();
  const module = await Test.createTestingModule({ imports: [ApiModule] })
    .overrideProvider(DatabaseConnection)
    .useValue({ database: database.database })
    .overrideProvider(SessionCacheInvalidationConnection)
    .useValue({ database: database.database })
    .overrideProvider(WalletSummaryInvalidationConnection)
    .useValue({ database: database.database })
    .overrideProvider(PROVIDER_FUNDING.clients)
    .useValue({
      paystack: new PaystackFundingGateway(
        'test',
        ledgerAccounts.paystack,
        paystackSecret,
        'https://axiapay.example/return',
        transport.send,
      ),
      opay: new OpayFundingGateway(
        'test',
        ledgerAccounts.opay,
        merchantId,
        'OPAYPUB-local-fixture',
        opaySecret,
        'https://axiapay.example/return',
        'https://axiapay.example/webhooks/opay',
        transport.send,
      ),
    })
    .compile();
  application = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    { logger: false, rawBody: true },
  );
  application.setGlobalPrefix('v1');
  await application.init();
  await application.getHttpAdapter().getInstance().ready();
});
beforeEach(() => {
  vi.restoreAllMocks();
  transport.loseInitializationResponse = false;
  transport.rejectVerification = false;
});
afterAll(async () => {
  await application?.close();
  await database?.stop();
});

/** Provision an authenticated fixture through the shared funding test setup. */
function customer(): Promise<FundingCustomer> {
  return createFundingCustomer(application, database);
}

/** Submit accepted customer terms without permitting any choice of owner, partner account, or evidence. */
function initialize(
  owner: FundingCustomer,
  partner: FundingPartner,
  overrides: Record<string, unknown> = {},
) {
  return application.inject({
    method: 'POST',
    url: `/v1/wallets/${owner.walletId}/funding-requests`,
    headers: { authorization: `Bearer ${owner.token}` },
    payload: {
      fundingOptionId: `${partner}-checkout`,
      currency: 'NGN',
      amountMinorUnits: '10000',
      payerEmail: 'payer@example.com',
      requestKey: randomUUID(),
      ...overrides,
    },
  });
}

/** Retrieve owner-authorized funding or explicitly request server reconciliation. */
function funding(owner: FundingCustomer, id: string, reconcile = false) {
  return application.inject({
    method: reconcile ? 'POST' : 'GET',
    url: `/v1/wallet-funding/${id}${reconcile ? '/reconcile' : ''}`,
    headers: { authorization: `Bearer ${owner.token}` },
  });
}

/** Query the public balance endpoint to assert visible money, not only internal request states. */
async function available(owner: FundingCustomer): Promise<string> {
  const response = await application.inject({
    method: 'GET',
    url: `/v1/wallets/${owner.walletId}/balance`,
    headers: { authorization: `Bearer ${owner.token}` },
  });
  expect(response.statusCode).toBe(200);
  return response.json().availableMinorUnits;
}

/** Sign fixture callbacks independently of production verifiers, including OPay's published canonical field order. */
function webhook(
  order: RemoteOrder,
  options: { tamper?: boolean; movementId?: string } = {},
) {
  const movementId = options.movementId ?? order.movementId;
  const commonHeaders = { 'content-type': 'application/json' };
  if (order.partner === 'paystack') {
    const body = JSON.stringify({
      event: 'charge.success',
      data: {
        domain: 'test',
        reference: order.reference,
        id: movementId,
        amount: order.amount,
        currency: order.currency,
        metadata: { walletId: randomUUID() },
      },
    });
    const signature = createHmac('sha512', paystackSecret)
      .update(body)
      .digest('hex');
    return application.inject({
      method: 'POST',
      url: '/v1/webhooks/wallet-funding/paystack',
      headers: { ...commonHeaders, 'x-paystack-signature': signature },
      payload: options.tamper ? `${body} ` : body,
    });
  }
  const payload = {
    amount: order.amount,
    currency: order.currency,
    reference: order.reference,
    refunded: false,
    status: 'SUCCESS',
    timestamp: '2026-10-13T01:00:00Z',
    token: movementId,
    transactionId: movementId,
  };
  const text = `{Amount:"${payload.amount}",Currency:"${payload.currency}",Reference:"${payload.reference}",Refunded:f,Status:"SUCCESS",Timestamp:"${payload.timestamp}",Token:"${movementId}",TransactionID:"${movementId}"}`;
  const signature = createHmac('sha3-512', opaySecret)
    .update(text)
    .digest('hex');
  return application.inject({
    method: 'POST',
    url: '/v1/webhooks/wallet-funding/opay',
    headers: commonHeaders,
    payload: JSON.stringify({
      type: 'transaction-status',
      payload: {
        ...payload,
        amount: options.tamper ? '999999' : payload.amount,
      },
      sha512: signature,
    }),
  });
}

describe.each(['opay', 'paystack'] as const)('%s wallet funding', (partner) => {
  it('persists immutable terms before checkout and initializes only once across concurrent request-key replays', async () => {
    const owner = await customer();
    const requestKey = randomUUID();
    const calls = transport.initializationCalls;
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        initialize(owner, partner, { requestKey }),
      ),
    );
    for (const response of responses) {
      expect(response.statusCode).toBe(202);
    }
    expect(
      new Set(responses.map((response) => response.json().fundingId)).size,
    ).toBe(1);
    expect(transport.initializationCalls - calls).toBe(1);
    const replay = await initialize(owner, partner, { requestKey });
    expect(replay.json()).toMatchObject({
      fundingOptionId: `${partner}-checkout`,
      fundingStatus: 'pending',
      amountMinorUnits: '10000',
      checkoutUrl: expect.stringContaining('https://'),
      operationId: null,
    });
    expect(replay.headers['cache-control']).toBe('no-store');
    expect(replay.json()).not.toHaveProperty('partnerAccountId');
    expect(await available(owner)).toBe('0');
    expect(
      (
        await initialize(owner, partner, {
          requestKey,
          amountMinorUnits: '10001',
        })
      ).statusCode,
    ).toBe(409);
  });

  it('requires a signature plus independent matching success and credits once under simultaneous webhooks and reconciliation', async () => {
    const owner = await customer();
    const initialized = await initialize(owner, partner);
    const request = initialized.json<FundingResponseDto>();
    const order = transport.orders.get(request.fundingId)!;
    expect((await webhook(order, { tamper: true })).statusCode).toBe(401);
    expect((await webhook(order)).statusCode).toBe(409); // Authentic notification alone is insufficient.
    expect(await available(owner)).toBe('0');
    order.status = 'success';
    const responses = await Promise.all([
      webhook(order),
      webhook(order),
      webhook(order),
      funding(owner, request.fundingId, true),
    ]);
    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(200);
    }
    expect(await available(owner)).toBe('10000');
    const result = (
      await funding(owner, request.fundingId)
    ).json<FundingResponseDto>();
    expect(result.fundingStatus).toBe('credited');
    const journal = await database.database
      .selectFrom('ledger_journals')
      .selectAll()
      .where('id', '=', result.operationId!)
      .execute();
    expect(journal).toHaveLength(1);
    const entries = await database.database
      .selectFrom('ledger_entries')
      .select(['entry_side', 'amount_minor_units'])
      .where('journal_id', '=', result.operationId!)
      .execute();
    expect(entries).toHaveLength(2);
    const outbox = await database.database
      .selectFrom('wallet_outbox_events')
      .selectAll()
      .where('id', '=', result.operationId!)
      .execute();
    expect(outbox).toHaveLength(1);
    // A committed duplicate can be acknowledged even when the partner's verification endpoint is down.
    transport.rejectVerification = true;
    expect((await webhook(order)).statusCode).toBe(200);
    expect(await available(owner)).toBe('10000');
  });

  it('rejects mismatched amount, currency, reference, webhook payment identity, and duplicate movement reassignment', async () => {
    const owner = await customer();
    const request = (
      await initialize(owner, partner)
    ).json<FundingResponseDto>();
    const order = transport.orders.get(request.fundingId)!;
    order.status = 'success';
    order.amount = '10001';
    expect((await webhook(order)).statusCode).toBe(400);
    order.amount = '10000';
    order.currency = 'USD';
    expect((await webhook(order)).statusCode).toBe(400);
    order.currency = 'NGN';
    expect((await webhook(order, { movementId: '999999' })).statusCode).toBe(
      400,
    );
    order.reference = randomUUID();
    expect((await funding(owner, request.fundingId, true)).statusCode).toBe(
      400,
    );
    order.reference = request.fundingId;
    expect(await available(owner)).toBe('0');
    expect((await webhook(order)).statusCode).toBe(200);
    const otherOwner = await customer();
    const other = (
      await initialize(otherOwner, partner)
    ).json<FundingResponseDto>();
    const otherOrder = transport.orders.get(other.fundingId)!;
    otherOrder.status = 'success';
    otherOrder.movementId = order.movementId;
    expect((await webhook(otherOrder)).statusCode).toBe(409);
    expect(await available(otherOwner)).toBe('0');
    expect(await available(owner)).toBe('10000');
  });

  it('retains identity after an ambiguous initialization and recovers without creating another partner order', async () => {
    const owner = await customer();
    const requestKey = randomUUID();
    transport.loseInitializationResponse = true;
    const uncertain = await initialize(owner, partner, { requestKey });
    expect(uncertain.statusCode).toBe(503);
    expect(uncertain.body).not.toContain('connection lost');
    const calls = transport.initializationCalls;
    const retry = await initialize(owner, partner, { requestKey });
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toMatchObject({
      fundingStatus: 'pending',
      checkoutUrl: null,
    });
    expect(transport.initializationCalls).toBe(calls);
    const order = transport.orders.get(retry.json().fundingId)!;
    order.status = 'success';
    expect((await webhook(order)).statusCode).toBe(200);
    expect(await available(owner)).toBe('10000');
  });

  it('does not acknowledge a verification outage, and safely replays a verified payment after ledger posting failure', async () => {
    const owner = await customer();
    const request = (
      await initialize(owner, partner)
    ).json<FundingResponseDto>();
    const order = transport.orders.get(request.fundingId)!;
    order.status = 'success';
    transport.rejectVerification = true;
    expect((await webhook(order)).statusCode).toBe(503);
    expect(await available(owner)).toBe('0');
    transport.rejectVerification = false;
    await database.administrator
      .updateTable('wallets')
      .set({ wallet_status: 'closed' })
      .where('id', '=', owner.walletId)
      .execute();
    expect((await webhook(order)).statusCode).toBe(409);
    expect((await funding(owner, request.fundingId)).json().fundingStatus).toBe(
      'pending',
    );
    // Administrative test repair models support resolving a blocked destination, followed by durable replay.
    await database.administrator
      .updateTable('wallets')
      .set({ wallet_status: 'frozen' })
      .where('id', '=', owner.walletId)
      .execute();
    expect((await webhook(order)).statusCode).toBe(200);
    expect(await available(owner)).toBe('10000');
  });

  it('enforces customer ownership and rejects forged financial fields before contacting the partner', async () => {
    const owner = await customer();
    const stranger = await customer();
    const calls = transport.initializationCalls;
    expect(
      (await initialize({ ...stranger, walletId: owner.walletId }, partner))
        .statusCode,
    ).toBe(404);
    for (const fields of [
      { actorId: stranger.actorId },
      { partnerAccountId: ledgerAccounts[partner] },
      { succeeded: true },
      { callbackUrl: 'https://attacker.example' },
      { amountMinorUnits: 10000 },
      { requestKey: '' },
    ]) {
      expect((await initialize(owner, partner, fields)).statusCode).toBe(400);
    }
    expect(transport.initializationCalls).toBe(calls);
    const request = (
      await initialize(owner, partner)
    ).json<FundingResponseDto>();
    expect((await funding(stranger, request.fundingId)).statusCode).toBe(404);
    expect((await funding(stranger, request.fundingId, true)).statusCode).toBe(
      404,
    );
    const anonymous = await application.inject({
      method: 'POST',
      url: `/v1/wallets/${owner.walletId}/funding-requests`,
      payload: {},
    });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('funding persistence protections', () => {
  it('recovers a lost response after credit without verifying or posting the payment a second time', async () => {
    const owner = await customer();
    const request = (
      await initialize(owner, 'paystack')
    ).json<FundingResponseDto>();
    const order = transport.orders.get(request.fundingId)!;
    order.status = 'success';
    const service = application.get(WalletFundingService);
    const original = service.receiveNotification.bind(service);
    vi.spyOn(service, 'receiveNotification').mockImplementationOnce(
      async (...input) => {
        await original(...input);
        throw new Error('simulated lost acknowledgement after commit');
      },
    );
    expect((await webhook(order)).statusCode).toBe(503);
    expect(await available(owner)).toBe('10000');
    transport.rejectVerification = true;
    expect((await webhook(order)).statusCode).toBe(200);
    expect(await available(owner)).toBe('10000');
  });

  it('does not report a legacy movement posted with different wallet terms as this request’s credit', async () => {
    const owner = await customer();
    const other = await customer();
    const request = (
      await initialize(owner, 'paystack')
    ).json<FundingResponseDto>();
    const order = transport.orders.get(request.fundingId)!;
    order.status = 'success';
    const legacy = await Test.createTestingModule({
      imports: [
        WalletModule.register({
          funding: {
            /** Model a preexisting trusted integration that already bound this movement elsewhere. */ async verifyFunding() {
              return {
                walletId: other.walletId,
                partnerAccountId: ledgerAccounts.paystack,
                externalMovementId: order.movementId,
                evidenceReference: 'legacy-test-evidence',
                value: money(10000n, 'NGN'),
              };
            },
          },
          paymentOutcome: {
            /** No settlements are permitted in this fixture. */ async verifyOutcome() {
              throw new Error('Not used.');
            },
          },
        }),
      ],
    })
      .overrideProvider(DatabaseConnection)
      .useValue({ database: database.database })
      .compile();
    try {
      await legacy
        .get(WalletService)
        .confirmWalletFunding('legacy-test-evidence');
      expect((await webhook(order)).statusCode).toBe(409);
      expect((await funding(owner, request.fundingId)).json()).toMatchObject({
        fundingStatus: 'pending',
        operationId: null,
      });
      expect(await available(owner)).toBe('0');
      expect(await available(other)).toBe('10000');
    } finally {
      await legacy.close();
    }
  });

  it('rejects direct changes to immutable intent bindings and verified payment identities', async () => {
    const owner = await customer();
    const request = (
      await initialize(owner, 'paystack')
    ).json<FundingResponseDto>();
    const order = transport.orders.get(request.fundingId)!;
    order.status = 'success';
    expect((await webhook(order)).statusCode).toBe(200);
    const saved = await database.administrator
      .selectFrom('wallet_funding_requests')
      .selectAll()
      .where('id', '=', request.fundingId)
      .executeTakeFirstOrThrow();
    await expect(
      database.administrator
        .insertInto('wallet_funding_requests')
        .values({
          ...saved,
          id: randomUUID(),
          request_key: randomUUID(),
          environment: 'live',
          initialization_started_at: null,
          checkout_url: null,
        })
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database.administrator
        .updateTable('wallet_funding_requests')
        .set({ amount_minor_units: '1' })
        .where('id', '=', request.fundingId)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database.administrator
        .deleteFrom('wallet_funding_payments')
        .where('funding_request_id', '=', request.fundingId)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database.database
        .updateTable('wallet_funding_requests')
        .set({ wallet_id: randomUUID() })
        .where('id', '=', request.fundingId)
        .execute(),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
