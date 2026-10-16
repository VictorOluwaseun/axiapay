/** Exercise session authorization and the public wallet contract against the migrated, restricted PostgreSQL ledger. */
import { randomBytes, randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
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
import { DatabaseConnection } from '@axiapay/backend/infrastructure/database/database.module';
import { AUTHENTICATION } from '../../src/modules/authentication/authentication.tokens.js';
import type { AuthenticationCodeDelivery } from '../../src/modules/authentication/ports/authentication.ports.js';
import type { AuthenticationResult } from '../../src/modules/authentication/services/authentication-session.js';
import { WalletModule } from '@axiapay/backend/modules/wallets/wallet.module';
import { WalletService } from '@axiapay/backend/modules/wallets/services/wallet.service';
import type { WalletBalanceResponseDto } from '../../src/modules/wallets/dtos/wallet-response.dto.js';
import type { ConfirmedFunding } from '@axiapay/backend/modules/wallets/ports/wallet-verification';
import { money } from '@axiapay/backend/modules/wallets/domain/money';
import {
  startWalletTestDatabase,
  type WalletTestDatabase,
} from '../../../../packages/backend/tests/support/wallet-test-database.js';

let database: WalletTestDatabase;
let application: NestFastifyApplication;
let integrationModule: TestingModule;
let trustedWallets: WalletService;
let currentTime = new Date('2030-01-01T00:00:00Z');
const deliveredCodes = new Map<string, string>();
const verifiedFunding = new Map<string, ConfirmedFunding>();

/** Test recipient captures codes through the actual delivery port, never through a public response. */
const delivery: AuthenticationCodeDelivery = {
  /** Deliver to the test recipient's private capture rather than a live provider. */
  async send(message) {
    deliveredCodes.set(message.challengeId, message.code);
  },
};

beforeAll(async () => {
  database = await startWalletTestDatabase();
  // Wallet posting still uses the restricted role; authentication needs its own table privileges.
  await sql`grant select, insert, update, delete on auth_accounts, auth_sessions, auth_challenges, auth_rate_limits to wallet_runtime`.execute(
    database.administrator,
  );
  const module = await Test.createTestingModule({ imports: [ApiModule] })
    .overrideProvider(DatabaseConnection)
    .useValue({ database: database.database })
    .overrideProvider(AUTHENTICATION.codeDelivery)
    .useValue(delivery)
    .overrideProvider(AUTHENTICATION.clock)
    .useValue({
      /** Control session expiry without sleeping or changing PostgreSQL time. */
      now: () => new Date(currentTime),
    })
    .compile();
  application = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    { logger: false },
  );
  application.setGlobalPrefix('v1');
  await application.init();
  await application.getHttpAdapter().getInstance().ready();

  // Trusted integration composition funds fixtures through the same journal service, not direct balance writes.
  integrationModule = await Test.createTestingModule({
    imports: [
      WalletModule.register({
        funding: {
          /** Accept only explicitly registered fixture evidence. */
          async verifyFunding(reference) {
            const funding = verifiedFunding.get(reference);
            if (!funding) {
              throw new Error('Unverified fixture funding.');
            }
            return funding;
          },
        },
        paymentOutcome: {
          /** These HTTP scenarios never fabricate settled payment outcomes. */
          async verifyOutcome() {
            throw new Error('Unverified fixture outcome.');
          },
        },
      }),
    ],
  })
    .overrideProvider(DatabaseConnection)
    .useValue({ database: database.database })
    .compile();
  trustedWallets = integrationModule.get(WalletService);
});

beforeEach(() => {
  // Isolate IP throttling windows while retaining immutable ledger history between scenarios.
  currentTime = new Date(currentTime.getTime() + 3_600_000);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await application?.close();
  await integrationModule?.close();
  await database?.stop();
});

/** One independently verified account and its public wallet snapshot. */
interface CustomerWallet {
  readonly session: AuthenticationResult;
  readonly wallet: WalletBalanceResponseDto;
}

/** Complete real signup verification and create a wallet through authenticated HTTP. */
async function customer(currency = 'NGN'): Promise<CustomerWallet> {
  const challenge = await application.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: {
      contact: { kind: 'email', value: `${randomUUID()}@example.com` },
    },
  });
  expect(challenge.statusCode).toBe(202);
  const challengeId = challenge.json().challengeId as string;
  const verified = await application.inject({
    method: 'POST',
    url: '/v1/auth/signup/verify',
    payload: { challengeId, code: deliveredCodes.get(challengeId) },
  });
  expect(verified.statusCode).toBe(201);
  const session = verified.json<AuthenticationResult>();
  const response = await application.inject({
    method: 'POST',
    url: '/v1/wallets',
    headers: { authorization: `Bearer ${session.accessToken}` },
    payload: { currency },
  });
  expect(response.statusCode).toBe(201);
  return { session, wallet: response.json<WalletBalanceResponseDto>() };
}

/** Supply settled evidence via a trusted fixture verifier and the real restricted ledger service. */
async function fund(
  customer: CustomerWallet,
  amountMinorUnits: bigint,
): Promise<void> {
  const reference = randomUUID();
  const partnerAccountId = randomUUID();
  await database.administrator
    .insertInto('ledger_accounts')
    .values({
      id: partnerAccountId,
      account_code: `partner:${partnerAccountId}`,
      account_kind: 'partner_funds',
      currency: customer.wallet.currency,
      wallet_id: null,
    })
    .execute();
  verifiedFunding.set(reference, {
    walletId: customer.wallet.id,
    partnerAccountId,
    externalMovementId: reference,
    evidenceReference: reference,
    value: money(amountMinorUnits, customer.wallet.currency),
  });
  await trustedWallets.confirmWalletFunding(reference);
}

/** Query a selected wallet using only the caller's bearer identity. */
function balance(customer: CustomerWallet, walletId = customer.wallet.id) {
  return application.inject({
    method: 'GET',
    url: `/v1/wallets/${walletId}/balance`,
    headers: { authorization: `Bearer ${customer.session.accessToken}` },
  });
}

/** Submit a caller-scoped transfer with explicit terms and allow hostile field overrides in validation scenarios. */
function transfer(
  source: CustomerWallet,
  destination: CustomerWallet,
  overrides: Record<string, unknown> = {},
  walletId = source.wallet.id,
) {
  return application.inject({
    method: 'POST',
    url: `/v1/wallets/${walletId}/transfers`,
    headers: { authorization: `Bearer ${source.session.accessToken}` },
    payload: {
      destinationWalletId: destination.wallet.id,
      currency: source.wallet.currency,
      amountMinorUnits: '100',
      requestKey: randomUUID(),
      ...overrides,
    },
  });
}

describe('authenticated wallet HTTP', () => {
  it('provisions only the verified account and returns the same owner/currency wallet on retries', async () => {
    const owner = await customer();
    const repeated = await application.inject({
      method: 'POST',
      url: '/v1/wallets',
      headers: { authorization: `Bearer ${owner.session.accessToken}` },
      payload: { currency: 'NGN' },
    });
    expect(repeated.statusCode).toBe(201);
    expect(repeated.headers['cache-control']).toBe('no-store');
    expect(repeated.json()).toEqual(owner.wallet);
    expect(owner.wallet).toEqual({
      id: expect.any(String),
      currency: 'NGN',
      walletStatus: 'active',
      availableMinorUnits: '0',
      reservedMinorUnits: '0',
      totalMinorUnits: '0',
    });
    const stored = await database.database
      .selectFrom('wallets')
      .select('owner_id')
      .where('id', '=', owner.wallet.id)
      .executeTakeFirstOrThrow();
    expect(stored.owner_id).toBe(owner.session.account.id);
  });

  it('serializes large exact balances and reservations without exposing internal account IDs', async () => {
    const owner = await customer();
    await fund(owner, 9_007_199_254_740_993n);
    await trustedWallets.reserveWalletFunds({
      actorId: owner.session.account.id,
      walletId: owner.wallet.id,
      requestKey: randomUUID(),
      paymentReference: randomUUID(),
      value: money(100n, 'NGN'),
    });
    const response = await balance(owner, owner.wallet.id.toUpperCase());
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.json()).toEqual({
      ...owner.wallet,
      availableMinorUnits: '9007199254740893',
      reservedMinorUnits: '100',
      totalMinorUnits: '9007199254740993',
    });
  });

  it('hides another account’s wallet and denies spending from it without changing either balance', async () => {
    const owner = await customer();
    const stranger = await customer();
    await fund(owner, 500n);
    const inaccessible = await balance(stranger, owner.wallet.id);
    const absent = await balance(stranger, randomUUID());
    expect(inaccessible.statusCode).toBe(404);
    // Per-request diagnostic references differ; inaccessible and absent wallets expose identical business information.
    expect(inaccessible.json()).toEqual({
      ...absent.json(),
      requestId: inaccessible.headers['x-request-id'],
    });
    const denied = await transfer(stranger, stranger, {}, owner.wallet.id);
    expect(denied.statusCode).toBe(404);
    expect(denied.json().code).toBe('WALLET_NOT_FOUND');
    expect((await balance(owner)).json().availableMinorUnits).toBe('500');
    expect((await balance(stranger)).json().availableMinorUnits).toBe('0');
  });

  it.each([
    'missing',
    'malformed',
    'unknown',
    'revoked',
    'expired',
    'disabled',
  ] as const)('rejects %s sessions on all wallet routes', async (state) => {
    const owner = await customer();
    let token = owner.session.accessToken;
    if (state === 'malformed') {
      token = 'not-a-session';
    }
    if (state === 'unknown') {
      token = randomBytes(32).toString('base64url');
    }
    if (state === 'revoked') {
      const logout = await application.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(logout.statusCode).toBe(204);
    }
    if (state === 'expired') {
      currentTime = new Date(
        currentTime.getTime() + owner.session.expiresInSeconds * 1000,
      );
    }
    if (state === 'disabled') {
      await database.administrator
        .updateTable('auth_accounts')
        .set({ disabled_at: currentTime })
        .where('id', '=', owner.session.account.id)
        .execute();
    }
    for (const [method, url] of [
      ['POST', '/v1/wallets'],
      ['GET', `/v1/wallets/${owner.wallet.id}/balance`],
      ['POST', `/v1/wallets/${owner.wallet.id}/transfers`],
    ] as const) {
      const response = await application.inject({
        method,
        url,
        headers:
          state === 'missing' ? {} : { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('INVALID_CREDENTIALS');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['www-authenticate']).toBe('Bearer');
    }
  });

  it('rejects forged identities, initial balances, and malformed creation inputs', async () => {
    const owner = await customer();
    for (const payload of [
      {},
      { currency: null },
      { currency: 'ngn' },
      { currency: 'NGN\n' },
      { currency: 123 },
      { currency: 'NGN', ownerId: randomUUID() },
      { currency: 'NGN', actorId: randomUUID() },
      { currency: 'NGN', availableMinorUnits: '99999999' },
    ]) {
      const response = await application.inject({
        method: 'POST',
        url: '/v1/wallets',
        headers: { authorization: `Bearer ${owner.session.accessToken}` },
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('INVALID_INPUT');
    }
    expect((await balance(owner)).json().availableMinorUnits).toBe('0');
  });

  it('rejects inexact amounts, invalid IDs, missing request keys, and over-posted transfer fields', async () => {
    const owner = await customer();
    const recipient = await customer();
    await fund(owner, 1000n);
    const invalidFields = [
      ...[
        100,
        1.5,
        null,
        {},
        '0',
        '-1',
        '1.5',
        '1e2',
        '01',
        '+1',
        ' 100',
        '100 ',
        '100\n',
        '9'.repeat(20),
      ].map((amountMinorUnits) => ({ amountMinorUnits })),
      { destinationWalletId: 'invalid-id' },
      { destinationWalletId: null },
      { requestKey: null },
      { requestKey: '' },
      { requestKey: 'request\u0000key' },
      { requestKey: ' padded ' },
      { requestKey: 'x'.repeat(201) },
      { actorId: recipient.session.account.id },
      { sourceWalletId: recipient.wallet.id },
      { settled: true },
      { currency: 'ngn' },
    ];
    for (const fields of invalidFields) {
      const response = await transfer(owner, recipient, fields);
      expect(response.statusCode, JSON.stringify(fields)).toBe(400);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    const missingKey = await transfer(owner, recipient, {
      requestKey: undefined,
    });
    expect(missingKey.statusCode).toBe(400);
    expect(
      (
        await transfer(owner, recipient, {
          amountMinorUnits: '9223372036854775808',
        })
      ).json().code,
    ).toBe('INVALID_AMOUNT');
    expect((await balance(owner, 'invalid-id')).statusCode).toBe(400);
    expect(
      (await transfer(owner, recipient, {}, 'invalid-id')).statusCode,
    ).toBe(400);
    expect((await balance(owner)).json().availableMinorUnits).toBe('1000');
  });

  it('commits once under concurrent retries, canonicalizes UUIDs, and rejects reuse with changed terms', async () => {
    const owner = await customer();
    const recipient = await customer();
    await fund(owner, 9_007_199_254_740_993n);
    const requestKey = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        transfer(owner, recipient, {
          requestKey,
          amountMinorUnits: '9007199254740993',
        }),
      ),
    );
    for (const response of responses) {
      expect(response.statusCode).toBe(200);
    }
    expect(
      new Set(responses.map((response) => response.json().operationId)).size,
    ).toBe(1);
    const replay = await transfer(
      owner,
      recipient,
      {
        requestKey,
        amountMinorUnits: '9007199254740993',
        destinationWalletId: recipient.wallet.id.toUpperCase(),
      },
      owner.wallet.id.toUpperCase(),
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({
      operationId: responses[0]!.json().operationId,
    });
    expect(replay.headers['cache-control']).toBe('no-store');
    const conflict = await transfer(owner, recipient, {
      requestKey,
      amountMinorUnits: '1',
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await balance(owner)).json().availableMinorUnits).toBe('0');
    expect((await balance(recipient)).json().availableMinorUnits).toBe(
      '9007199254740993',
    );
  });

  it('isolates request keys by authenticated owner', async () => {
    const owner = await customer();
    const recipient = await customer();
    await fund(owner, 200n);
    const requestKey = randomUUID();
    const outbound = await transfer(owner, recipient, { requestKey });
    const inbound = await transfer(recipient, owner, { requestKey });
    expect(outbound.statusCode).toBe(200);
    expect(inbound.statusCode).toBe(200);
    expect(inbound.json().operationId).not.toBe(outbound.json().operationId);
    expect((await balance(owner)).json().availableMinorUnits).toBe('200');
  });

  it('does not overspend under concurrent distinct transfer requests', async () => {
    const owner = await customer();
    const recipient = await customer();
    await fund(owner, 100n);
    const responses = await Promise.all([
      transfer(owner, recipient, { amountMinorUnits: '75' }),
      transfer(owner, recipient, { amountMinorUnits: '75' }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 409,
    ]);
    expect(
      responses.find((response) => response.statusCode === 409)!.json().code,
    ).toBe('INSUFFICIENT_FUNDS');
    expect((await balance(owner)).json().availableMinorUnits).toBe('25');
    expect((await balance(recipient)).json().availableMinorUnits).toBe('75');
  });

  it('enforces funds, currency, and wallet state with stable public failures', async () => {
    const owner = await customer();
    const recipient = await customer();
    const otherCurrency = await customer('USD');
    expect((await transfer(owner, recipient)).json().code).toBe(
      'INSUFFICIENT_FUNDS',
    );
    await fund(owner, 200n);
    expect((await transfer(owner, owner)).json().code).toBe('INVALID_TRANSFER');
    expect((await transfer(owner, otherCurrency)).json().code).toBe(
      'CURRENCY_MISMATCH',
    );
    await database.administrator
      .updateTable('wallets')
      .set({ wallet_status: 'frozen' })
      .where('id', '=', owner.wallet.id)
      .execute();
    const restricted = await transfer(owner, recipient);
    expect(restricted.statusCode).toBe(409);
    expect(restricted.json().code).toBe('WALLET_RESTRICTED');
    expect((await balance(owner)).json()).toMatchObject({
      walletStatus: 'frozen',
      availableMinorUnits: '200',
    });
  });

  it('redacts uncertain commit errors and safely reconciles a retry using the original key', async () => {
    const owner = await customer();
    const recipient = await customer();
    await fund(owner, 200n);
    const wallets = application
      .select(WalletModule)
      .get(WalletService, { strict: true });
    const original = wallets.transferBetweenWallets.bind(wallets);
    vi.spyOn(wallets, 'transferBetweenWallets').mockImplementationOnce(
      async (input) => {
        await original(input);
        throw new Error('simulated lost response: private SQL and credentials');
      },
    );
    const requestKey = randomUUID();
    const uncertain = await transfer(owner, recipient, { requestKey });
    expect(uncertain.statusCode).toBe(503);
    expect(uncertain.headers['cache-control']).toBe('no-store');
    expect(uncertain.json()).toEqual({
      statusCode: 503,
      requestId: uncertain.headers['x-request-id'],
      code: 'WALLET_UNAVAILABLE',
      message:
        'Wallet operation unavailable. Retry transfers with the same request key and terms.',
    });
    const recovered = await transfer(owner, recipient, { requestKey });
    expect(recovered.statusCode).toBe(200);
    expect((await balance(owner)).json().availableMinorUnits).toBe('100');
    expect((await balance(recipient)).json().availableMinorUnits).toBe('100');
  });

  it('does not expose trusted funding, reservation, or settlement operations to customers', async () => {
    const owner = await customer();
    for (const route of ['funding', 'reservations', 'settlements']) {
      const response = await application.inject({
        method: 'POST',
        url: `/v1/wallets/${owner.wallet.id}/${route}`,
        headers: { authorization: `Bearer ${owner.session.accessToken}` },
        payload: { amountMinorUnits: '100', succeeded: true },
      });
      expect(response.statusCode).toBe(404);
    }
    expect((await balance(owner)).json().availableMinorUnits).toBe('0');
  });
});
