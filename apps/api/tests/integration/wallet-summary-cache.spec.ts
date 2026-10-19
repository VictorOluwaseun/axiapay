import { TestRemoteConfigRepository } from '../support/remote-config.js';
import { REMOTE_CONFIG_REPOSITORY } from '../../src/modules/remote-config/remote-config.tokens.js';
/** Exercise owner-scoped display caching, committed invalidation and recovery through independent API/cache/database instances. */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
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
import { createDatabase } from '@axiapay/payments-runtime/infrastructure/database/create-database';
import { DatabaseConnection } from '@axiapay/payments-runtime/infrastructure/database/database.module';
import { WalletModule } from '@axiapay/payments-runtime/modules/wallets/wallet.module';
import { WalletService } from '@axiapay/payments-runtime/modules/wallets/services/wallet.service';
import { money } from '@axiapay/payments-runtime/modules/wallets/domain/money';
import type {
  ConfirmedFunding,
  VerifiedPaymentOutcome,
} from '@axiapay/payments-runtime/modules/wallets/ports/wallet-verification';
import {
  startWalletTestDatabase,
  type WalletTestDatabase,
} from '../../../../packages/payments-runtime/tests/support/wallet-test-database.js';
import { asyncSignal } from '../../../../packages/payments-runtime/tests/support/async-signal.js';
import { RequestValidationModule } from '../../src/bootstrap/request-validation.module.js';
import { RedisCacheConnection } from '../../src/infrastructure/redis/redis-cache-connection.js';
import { SessionCacheInvalidationConnection } from '../../src/infrastructure/database/session-cache-invalidation.connection.js';
import { WalletSummaryInvalidationConnection } from '../../src/infrastructure/database/wallet-summary-invalidation.connection.js';
import { AUTHENTICATION } from '../../src/modules/authentication/authentication.tokens.js';
import { RedisSessionIdentityCache } from '../../src/modules/authentication/data-sources/redis-session-identity-cache.js';
import { PostgresSessionCacheInvalidationRepository } from '../../src/modules/authentication/repositories/postgres-session-cache-invalidation.repository.js';
import type { AuthenticationCodeDelivery } from '../../src/modules/authentication/ports/authentication.ports.js';
import type { AuthenticationResult } from '../../src/modules/authentication/services/authentication-session.js';
import { WalletHttpModule } from '../../src/modules/wallets/wallet-http.module.js';
import { WALLET_SUMMARY } from '../../src/modules/wallets/wallet-summary.tokens.js';
import { RedisWalletSummaryCache } from '../../src/modules/wallets/data-sources/redis-wallet-summary-cache.js';
import { PostgresWalletSummaryInvalidationRepository } from '../../src/modules/wallets/repositories/postgres-wallet-summary-invalidation.repository.js';
import type { WalletBalanceResponseDto } from '../../src/modules/wallets/dtos/wallet-response.dto.js';

let database: WalletTestDatabase;
let container: StartedTestContainer;
let primary: Replica;
let secondary: Replica;
let trustedModule: TestingModule;
let trustedWallets: WalletService;
let currentTime = new Date('2030-01-01T00:00:00Z');
const codes = new Map<string, string>();
const fundingEvidence = new Map<string, ConfirmedFunding>();
const outcomes = new Map<string, VerifiedPaymentOutcome>();
const secret = '11'.repeat(32);

/** Each replica owns independent cache state, business pool and bounded outbox recovery pools. */
async function startReplica() {
  const business = createDatabase(database.connectionString);
  const connection = new RedisCacheConnection(
    new ConfigService({
      REDIS_CACHE_URL: `redis://${container.getHost()}:${container.getMappedPort(6379)}`,
    }),
  );
  await connection.client.connect();
  const cache = new RedisWalletSummaryCache(connection, secret);
  const sessionCache = new RedisSessionIdentityCache(connection, secret);
  const recoveryConnection = new WalletSummaryInvalidationConnection(
    new ConfigService({ DATABASE_URL: database.connectionString }),
  );
  const sessionConnection = new SessionCacheInvalidationConnection(
    new ConfigService({ DATABASE_URL: database.connectionString }),
  );
  const module = await Test.createTestingModule({
    imports: [RequestValidationModule, WalletHttpModule],
  })
    .overrideProvider(REMOTE_CONFIG_REPOSITORY)
    .useValue(new TestRemoteConfigRepository())
    .overrideProvider(DatabaseConnection)
    .useValue({ database: business })
    .overrideProvider(RedisCacheConnection)
    .useValue(connection)
    .overrideProvider(WalletSummaryInvalidationConnection)
    .useValue(recoveryConnection)
    .overrideProvider(SessionCacheInvalidationConnection)
    .useValue(sessionConnection)
    .overrideProvider(WALLET_SUMMARY.cache)
    .useValue(cache)
    .overrideProvider(AUTHENTICATION.sessionIdentityCache)
    .useValue(sessionCache)
    .overrideProvider(AUTHENTICATION.codeDelivery)
    .useValue({
      /** Capture only synthetic signup proof through the private delivery port. */
      async send(message) {
        codes.set(message.challengeId, message.code);
      },
    } satisfies AuthenticationCodeDelivery)
    .overrideProvider(AUTHENTICATION.clock)
    .useValue({
      /** Advance authentication rate-limit windows without changing cache or recovery time. */
      now: () => new Date(currentTime),
    })
    .compile();
  const invalidations = module.get<PostgresWalletSummaryInvalidationRepository>(
    WALLET_SUMMARY.invalidations,
  );
  const sessionInvalidations =
    module.get<PostgresSessionCacheInvalidationRepository>(
      AUTHENTICATION.sessionCacheInvalidations,
    );
  // Deterministic tests drive recovery explicitly, except the periodic-recovery scenario.
  vi.spyOn(invalidations, 'onModuleInit').mockImplementation(() => undefined);
  vi.spyOn(sessionInvalidations, 'onModuleInit').mockImplementation(
    () => undefined,
  );
  const application = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    { logger: false },
  );
  application.setGlobalPrefix('v1');
  await application.init();
  await application.getHttpAdapter().getInstance().ready();
  await invalidations.flush();
  await sessionInvalidations.flush();
  return {
    application,
    business,
    connection,
    cache,
    invalidations,
    sessionInvalidations,
    recoveryConnection,
    /** Release this replica's managed connections without closing the shared disposable database. */
    async close() {
      await application.close();
      await business.destroy();
    },
  };
}

/** Ready-to-use independent API and storage fixture. */
type Replica = Awaited<ReturnType<typeof startReplica>>;

beforeAll(async () => {
  database = await startWalletTestDatabase();
  await sql`grant select, insert, update, delete on auth_accounts, auth_sessions, auth_refresh_tokens, auth_challenges, auth_rate_limits to wallet_runtime;
    grant select, delete on auth_session_cache_invalidations to wallet_runtime;
    select grant_wallet_summary_cache_runtime_access('wallet_runtime');`.execute(
    database.administrator,
  );
  container = await new GenericContainer('redis:8-alpine')
    .withExposedPorts(6379)
    .start();
  primary = await startReplica();
  secondary = await startReplica();
  trustedModule = await Test.createTestingModule({
    imports: [
      WalletModule.register({
        funding: {
          /** Accept only settled evidence registered for this isolated fixture. */
          async verifyFunding(reference) {
            const evidence = fundingEvidence.get(reference);
            if (!evidence) {
              throw new Error('Unregistered fixture funding.');
            }
            return evidence;
          },
        },
        paymentOutcome: {
          /** Verify only explicitly registered fixture outcomes. */
          async verifyOutcome(reference) {
            const outcome = outcomes.get(reference);
            if (!outcome) {
              throw new Error('Unregistered fixture outcome.');
            }
            return outcome;
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

beforeEach(async () => {
  vi.restoreAllMocks();
  currentTime = new Date(currentTime.getTime() + 3_600_000);
  primary.connection.reportRecovery();
  secondary.connection.reportRecovery();
  await primary.connection.client.flushdb();
  await primary.invalidations.flush();
  await secondary.invalidations.flush();
  await primary.sessionInvalidations.flush();
  await secondary.sessionInvalidations.flush();
});

afterAll(async () => {
  await secondary?.close();
  await primary?.close();
  await trustedModule?.close();
  await container?.stop();
  await database?.stop();
});

/** Verify a fresh public signup and retain the automatically provisioned NGN wallet. */
async function customer() {
  const requested = await primary.application.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: {
      contact: { kind: 'email', value: `${randomUUID()}@example.com` },
    },
  });
  expect(requested.statusCode).toBe(202);
  const challengeId = requested.json().challengeId as string;
  const verified = await primary.application.inject({
    method: 'POST',
    url: '/v1/auth/signup/verify',
    payload: { challengeId, code: codes.get(challengeId) },
  });
  expect(verified.statusCode).toBe(201);
  const session = verified.json<AuthenticationResult>();
  const response = await summary(session);
  expect(response.statusCode).toBe(200);
  return { ...session, wallet: response.json<WalletBalanceResponseDto>() };
}

/** Request the current wallet through the real guard and authenticated-account decorator. */
function summary(
  user: AuthenticationResult,
  replica = primary,
  query = 'currency=NGN',
) {
  return replica.application.inject({
    method: 'GET',
    url: `/v1/wallets/me?${query}`,
    headers: { authorization: `Bearer ${user.accessToken}` },
  });
}

/** Fund through the authoritative journal workflow, representing an independent worker write. */
async function fund(user: Awaited<ReturnType<typeof customer>>, amount = 500n) {
  const reference = randomUUID();
  const partnerAccountId = randomUUID();
  await database.administrator
    .insertInto('ledger_accounts')
    .values({
      id: partnerAccountId,
      account_code: `partner:${partnerAccountId}`,
      account_kind: 'partner_funds',
      currency: 'NGN',
      wallet_id: null,
    })
    .execute();
  fundingEvidence.set(reference, {
    walletId: user.wallet.id,
    partnerAccountId,
    externalMovementId: reference,
    evidenceReference: reference,
    value: money(amount, 'NGN'),
  });
  await trustedWallets.confirmWalletFunding(reference);
}

/** Submit a real owner-authorized transfer and let the HTTP interceptor deliver its committed invalidations. */
function transfer(
  source: Awaited<ReturnType<typeof customer>>,
  destination: Awaited<ReturnType<typeof customer>>,
  amount = '100',
) {
  return primary.application.inject({
    method: 'POST',
    url: `/v1/wallets/${source.wallet.id}/transfers`,
    headers: { authorization: `Bearer ${source.accessToken}` },
    payload: {
      destinationWalletId: destination.wallet.id,
      currency: 'NGN',
      amountMinorUnits: amount,
      requestKey: randomUUID(),
    },
  });
}

/** Read only committed outbox events under the restricted delivery role. */
async function pending() {
  return database.database
    .selectFrom('wallet_summary_cache_invalidations')
    .selectAll()
    .execute();
}

/** Identify this customer's cached summary through its signed payload without exposing any live credentials. */
async function summaryKey(ownerId: string, currency = 'NGN') {
  const keys = await primary.connection.client.keys(
    'wallet:summary:v1:*:summary:*',
  );
  for (const key of keys) {
    const encoded = await primary.connection.client.get(key);
    const payload = JSON.parse(JSON.parse(encoded!).payload);
    if (
      payload.wallet.ownerId === ownerId &&
      payload.wallet.currency === currency
    ) {
      return key;
    }
  }
  throw new Error('Expected fixture summary cache entry.');
}

describe('current wallet summary and cache', () => {
  it('returns the signup wallet with exact string amounts and serves SQL-free hits on an independent API', async () => {
    const user = await customer();
    expect(primary.cache).not.toBe(secondary.cache);
    expect(primary.business).not.toBe(secondary.business);
    const query = vi.spyOn(secondary.business.getExecutor(), 'executeQuery');
    const response = await summary(user, secondary);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.json()).toEqual({
      id: user.wallet.id,
      currency: 'NGN',
      walletStatus: 'active',
      availableMinorUnits: '0',
      reservedMinorUnits: '0',
      totalMinorUnits: '0',
    });
    expect(query).not.toHaveBeenCalled();
    expect(
      await primary.connection.client.pttl(await summaryKey(user.account.id)),
    ).toBeGreaterThan(0);
    expect(
      await primary.connection.client.pttl(await summaryKey(user.account.id)),
    ).toBeLessThanOrEqual(15_000);
  });

  it('isolates authenticated owners and currencies, including copied cache payloads', async () => {
    const alice = await customer();
    const bob = await customer();
    await fund(alice, 900n);
    await primary.invalidations.flush();
    expect((await summary(alice)).json().availableMinorUnits).toBe('900');
    const aliceKey = await summaryKey(alice.account.id);
    const bobKey = await summaryKey(bob.account.id);
    await primary.connection.client.set(
      bobKey,
      (await primary.connection.client.get(aliceKey))!,
      'PX',
      15_000,
    );
    const query = vi.spyOn(secondary.business.getExecutor(), 'executeQuery');
    const response = await summary(bob, secondary);
    expect(response.json()).toEqual(bob.wallet);
    expect(query).toHaveBeenCalledTimes(1);
    const created = await primary.application.inject({
      method: 'POST',
      url: '/v1/wallets',
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { currency: 'USD' },
    });
    expect(created.statusCode).toBe(201);
    const usd = await summary(alice, secondary, 'currency=USD');
    expect(usd.json()).toMatchObject({
      currency: 'USD',
      availableMinorUnits: '0',
    });
    expect(usd.json().id).not.toBe(alice.wallet.id);
    expect((await summary(alice)).json().availableMinorUnits).toBe('900');
  });

  it.each([
    '',
    'currency=ngn',
    'currency=NGN%0A',
    'currency=NGN&currency=USD',
    'currency=NGN&ownerId=forged',
    'currency=NGN&actorId=forged',
  ])(
    'rejects invalid or over-posted query inputs before wallet access (%s)',
    async (query) => {
      const user = await customer();
      const read = vi.spyOn(primary.cache, 'read');
      const response = await summary(user, primary, query);
      expect(response.statusCode).toBe(400);
      expect(read).not.toHaveBeenCalled();
    },
  );

  it('returns 404 without creating a wallet or negative-caching it, then discovers explicit creation', async () => {
    const user = await customer();
    const before = await database.database
      .selectFrom('ledger_accounts')
      .select('id')
      .execute();
    expect((await summary(user, primary, 'currency=USD')).statusCode).toBe(404);
    expect(
      await database.database
        .selectFrom('ledger_accounts')
        .select('id')
        .execute(),
    ).toEqual(before);
    expect(
      await database.database
        .selectFrom('wallets')
        .select('id')
        .where('owner_id', '=', user.account.id)
        .execute(),
    ).toHaveLength(1);
    const created = await primary.application.inject({
      method: 'POST',
      url: '/v1/wallets',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { currency: 'USD' },
    });
    expect(created.statusCode).toBe(201);
    expect((await summary(user, secondary, 'currency=USD')).json()).toEqual(
      created.json(),
    );
  });

  it('discovers wallets through the same shared service in a worker composition without Redis', async () => {
    const user = await customer();
    await fund(user, 700n);
    // This fixture's worker imports WalletModule.register without the API cache binding.
    // Its reads must see committed money even while the API display snapshot awaits delivery.
    expect((await summary(user, secondary)).json().availableMinorUnits).toBe(
      '0',
    );
    const query = vi.spyOn(database.database.getExecutor(), 'executeQuery');
    const wallet = await trustedWallets.getWalletByOwner(
      user.account.id,
      'NGN',
    );
    expect(wallet).toEqual({
      id: user.wallet.id,
      ownerId: user.account.id,
      currency: 'NGN',
      walletStatus: 'active',
      availableMinorUnits: 700n,
      reservedMinorUnits: 0n,
    });
    await trustedWallets.getWalletByOwner(user.account.id, 'NGN');
    expect(query).toHaveBeenCalledTimes(2);
    await expect(
      trustedWallets.getWalletByOwner(user.account.id, 'USD'),
    ).rejects.toMatchObject({ code: 'WALLET_NOT_FOUND' });
    expect(
      await database.database
        .selectFrom('wallets')
        .select('id')
        .where('owner_id', '=', user.account.id)
        .execute(),
    ).toHaveLength(1);
  });

  it('requires a valid session even when the wallet summary is cached', async () => {
    const user = await customer();
    expect(
      (
        await primary.application.inject({
          method: 'GET',
          url: '/v1/wallets/me?currency=NGN',
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await primary.application.inject({
          method: 'POST',
          url: '/v1/auth/logout',
          headers: { authorization: `Bearer ${user.accessToken}` },
        })
      ).statusCode,
    ).toBe(204);
    expect((await summary(user, secondary)).statusCode).toBe(401);
  });

  it('loads a miss once, then serves hits, and rejects tampered or absolutely expired summaries', async () => {
    const user = await customer();
    const key = await summaryKey(user.account.id);
    await primary.connection.client.del(key);
    const query = vi.spyOn(secondary.business.getExecutor(), 'executeQuery');
    expect((await summary(user, secondary)).json()).toEqual(user.wallet);
    expect(query).toHaveBeenCalledTimes(1);
    query.mockClear();
    expect((await summary(user, secondary)).json()).toEqual(user.wallet);
    expect(query).not.toHaveBeenCalled();
    const encoded = (await primary.connection.client.get(key))!;
    const envelope = JSON.parse(encoded);
    const payload = JSON.parse(envelope.payload);
    const expiresAtMs = payload.expiresAtMs as number;
    payload.wallet.availableMinorUnits = '999999';
    envelope.payload = JSON.stringify(payload);
    await primary.connection.client.set(
      key,
      JSON.stringify(envelope),
      'PX',
      15_000,
    );
    expect((await summary(user, secondary)).json()).toEqual(user.wallet);
    expect(query).toHaveBeenCalledTimes(1);
    await primary.connection.client.set(key, encoded, 'PX', 15_000);
    expect(
      (
        await secondary.cache.read(
          user.account.id,
          'NGN',
          new Date(expiresAtMs),
        )
      )?.snapshot,
    ).toBeNull();
    const lookup = await secondary.cache.read(
      user.account.id,
      'NGN',
      new Date(),
    );
    const oldSnapshot = lookup!.snapshot!;
    await primary.connection.client.del(key);
    await secondary.cache.write(
      oldSnapshot,
      new Date(Date.now() - 15_000),
      lookup!.ticket,
    );
    expect(await primary.connection.client.get(key)).toBeNull();
  });

  it('resets previously acknowledged stale Redis state on reconnect before enabling wallet hits', async () => {
    const user = await customer();
    const keys = await primary.connection.client.keys('wallet:summary:v1:*');
    const saved = await Promise.all(
      keys.map(async (key) => ({
        key,
        dump: await primary.connection.client.dumpBuffer(key),
        ttl: await primary.connection.client.pttl(key),
      })),
    );
    await fund(user);
    await secondary.invalidations.flush();
    expect(await pending()).toEqual([]);
    for (const entry of saved) {
      await primary.connection.client.restore(
        entry.key,
        Math.max(0, entry.ttl),
        entry.dump!,
        'REPLACE',
      );
    }
    primary.connection.client.emit('close');
    primary.connection.client.emit('ready');
    expect((await summary(user)).json().availableMinorUnits).toBe('500');
    await primary.invalidations.flush();
    expect((await summary(user, secondary)).json().availableMinorUnits).toBe(
      '500',
    );
  });

  it('invalidates both sides before a committed transfer response, including a response failure after commit', async () => {
    const alice = await customer();
    const bob = await customer();
    await fund(alice);
    await primary.invalidations.flush();
    await summary(alice);
    await summary(bob);
    expect((await transfer(alice, bob)).statusCode).toBe(200);
    expect((await summary(alice, secondary)).json().availableMinorUnits).toBe(
      '400',
    );
    expect((await summary(bob, secondary)).json().availableMinorUnits).toBe(
      '100',
    );
    const wallets = primary.application.get(WalletService);
    const original = wallets.transferBetweenWallets.bind(wallets);
    vi.spyOn(wallets, 'transferBetweenWallets').mockImplementationOnce(
      async (input) => {
        await original(input);
        throw new Error('Fixture lost response after commit.');
      },
    );
    expect((await transfer(alice, bob)).statusCode).toBe(503);
    expect((await summary(alice, secondary)).json().availableMinorUnits).toBe(
      '300',
    );
    expect((await summary(bob, secondary)).json().availableMinorUnits).toBe(
      '200',
    );
    expect(await pending()).toEqual([]);
  });

  it('invalidates independent worker funding, reservations and releases with exact large balances', async () => {
    const user = await customer();
    await fund(user, 9_007_199_254_740_993n);
    await secondary.invalidations.flush();
    expect((await summary(user)).json().totalMinorUnits).toBe(
      '9007199254740993',
    );
    const paymentReference = randomUUID();
    const held = await trustedWallets.reserveWalletFunds({
      actorId: user.account.id,
      walletId: user.wallet.id,
      paymentReference,
      requestKey: randomUUID(),
      value: money(100n, 'NGN'),
    });
    await secondary.invalidations.flush();
    expect((await summary(user)).json()).toMatchObject({
      availableMinorUnits: '9007199254740893',
      reservedMinorUnits: '100',
      totalMinorUnits: '9007199254740993',
    });
    const reservationId = held.operationId;
    const evidenceReference = randomUUID();
    outcomes.set(evidenceReference, {
      outcome: 'failed',
      paymentReference,
      fundsSafeToRelease: true,
      evidenceReference,
    });
    await trustedWallets.settleWalletReservation({
      reservationId,
      evidenceReference,
    });
    await secondary.invalidations.flush();
    expect((await summary(user)).json()).toMatchObject({
      availableMinorUnits: '9007199254740993',
      reservedMinorUnits: '0',
    });
  });

  it('invalidates status changes and keeps financial authorization authoritative during failed display invalidation', async () => {
    const alice = await customer();
    const bob = await customer();
    await fund(alice);
    await primary.invalidations.flush();
    await summary(alice);
    const failure = vi
      .spyOn(primary.cache, 'invalidate')
      .mockRejectedValue(new Error('Fixture Redis delivery failure.'));
    await database.administrator
      .updateTable('wallets')
      .set({ wallet_status: 'frozen' })
      .where('id', '=', alice.wallet.id)
      .execute();
    await primary.invalidations.flush();
    expect((await summary(alice, secondary)).json().walletStatus).toBe(
      'active',
    );
    expect((await transfer(alice, bob)).json().code).toBe('WALLET_RESTRICTED');
    expect((await summary(alice)).json().walletStatus).toBe('frozen');
    failure.mockRestore();
    await secondary.invalidations.flush();
    expect((await summary(alice, secondary)).json().walletStatus).toBe(
      'frozen',
    );
  });

  it('retains failed invalidations durably, bypasses local cache, and recovers through an independent API', async () => {
    const user = await customer();
    await fund(user);
    const failure = vi
      .spyOn(primary.cache, 'invalidate')
      .mockRejectedValue(new Error('Fixture invalidation failure.'));
    await primary.invalidations.flush();
    expect(await pending()).toEqual([
      expect.objectContaining({ cache_key: `${user.account.id}:NGN` }),
    ]);
    expect((await summary(user)).json().availableMinorUnits).toBe('500');
    expect((await summary(user, secondary)).json().availableMinorUnits).toBe(
      '0',
    );
    failure.mockRestore();
    await secondary.invalidations.flush();
    expect(await pending()).toEqual([]);
    expect((await summary(user, secondary)).json().availableMinorUnits).toBe(
      '500',
    );
    await primary.invalidations.flush();
    const query = vi.spyOn(primary.business.getExecutor(), 'executeQuery');
    expect((await summary(user)).json().availableMinorUnits).toBe('500');
    expect(query).not.toHaveBeenCalled();
  });

  it('replays pending work on startup after a failed invalidation', async () => {
    const user = await customer();
    await fund(user);
    vi.spyOn(primary.cache, 'invalidate').mockRejectedValue(
      new Error('Fixture outage.'),
    );
    await primary.invalidations.flush();
    const restarted = await startReplica();
    try {
      expect(await pending()).toEqual([]);
      expect((await summary(user, restarted)).json().availableMinorUnits).toBe(
        '500',
      );
    } finally {
      await restarted.close();
    }
  });

  it.each(['invalidation', 'fence-eviction', 'redis-reset'] as const)(
    'rejects a stale fill after %s on an independent replica',
    async (change) => {
      const user = await customer();
      await primary.connection.client.del(await summaryKey(user.account.id));
      const observed = asyncSignal();
      const release = asyncSignal();
      const original = primary.cache.write.bind(primary.cache);
      vi.spyOn(primary.cache, 'write').mockImplementationOnce(
        async (wallet, now, ticket) => {
          observed.resolve();
          await release.promise;
          await original(wallet, now, ticket);
        },
      );
      const responsePromise = summary(user).then((response) => response);
      await observed.promise;
      try {
        await fund(user);
        await secondary.invalidations.flush();
        if (change === 'fence-eviction') {
          const keys = await primary.connection.client.keys(
            'wallet:summary:v1:*:fence:*',
          );
          await primary.connection.client.del(...keys);
        }
        if (change === 'redis-reset') {
          await primary.connection.client.flushdb();
        }
        expect(
          (await summary(user, secondary)).json().availableMinorUnits,
        ).toBe('500');
      } finally {
        release.resolve();
      }
      expect((await responsePromise).json().availableMinorUnits).toBe('0');
      expect((await summary(user)).json().availableMinorUnits).toBe('500');
    },
  );

  it('does not acknowledge a newer committed invalidation with an older delivered version', async () => {
    const user = await customer();
    await fund(user, 100n);
    const original = primary.cache.invalidate.bind(primary.cache);
    const delivered = vi
      .spyOn(primary.cache, 'invalidate')
      .mockImplementationOnce(async (namespace, scopes) => {
        await original(namespace, scopes);
        await fund(user, 200n);
      });
    await primary.invalidations.flush();
    expect(delivered).toHaveBeenCalledTimes(2);
    expect(await pending()).toEqual([]);
    expect((await summary(user, secondary)).json().availableMinorUnits).toBe(
      '300',
    );
  });

  it('publishes no invalidation for rolled-back status changes and rolls back money if durable enqueue fails', async () => {
    const alice = await customer();
    const bob = await customer();
    await fund(alice);
    await primary.invalidations.flush();
    await summary(alice);
    const encoded = await primary.connection.client.get(
      await summaryKey(alice.account.id),
    );
    await expect(
      database.administrator.transaction().execute(async (transaction) => {
        await transaction
          .updateTable('wallets')
          .set({ wallet_status: 'frozen' })
          .where('id', '=', alice.wallet.id)
          .execute();
        throw new Error('Fixture rollback.');
      }),
    ).rejects.toThrow('Fixture rollback.');
    expect(await pending()).toEqual([]);
    await primary.invalidations.flush();
    expect(
      await primary.connection.client.get(await summaryKey(alice.account.id)),
    ).toBe(encoded);
    await sql`alter table wallet_summary_cache_invalidations add constraint fixture_block_wallet_outbox check (false) not valid`.execute(
      database.administrator,
    );
    try {
      expect((await transfer(alice, bob)).statusCode).toBe(503);
      expect(
        (
          await trustedWallets.getWalletBalance({
            actorId: alice.account.id,
            walletId: alice.wallet.id,
          })
        ).availableMinorUnits,
      ).toBe(500n);
      expect(
        (
          await trustedWallets.getWalletBalance({
            actorId: bob.account.id,
            walletId: bob.wallet.id,
          })
        ).availableMinorUnits,
      ).toBe(0n);
    } finally {
      await sql`alter table wallet_summary_cache_invalidations drop constraint fixture_block_wallet_outbox`.execute(
        database.administrator,
      );
    }
  });

  it('falls back to PostgreSQL during a Redis outage and bounds post-commit invalidation waits', async () => {
    const user = await customer();
    primary.connection.reportFailure();
    const query = vi.spyOn(primary.business.getExecutor(), 'executeQuery');
    expect((await summary(user)).json()).toEqual(user.wallet);
    expect(query).toHaveBeenCalled();
    primary.connection.reportRecovery();
    await fund(user);
    const lock = asyncSignal();
    const release = asyncSignal();
    const blocker = database.administrator
      .transaction()
      .execute(async (transaction) => {
        await sql`lock table wallet_summary_cache_invalidations in access exclusive mode`.execute(
          transaction,
        );
        lock.resolve();
        await release.promise;
      });
    await lock.promise;
    const started = performance.now();
    try {
      await primary.invalidations.flush();
      expect(performance.now() - started).toBeLessThan(750);
    } finally {
      release.resolve();
      await blocker;
    }
    await primary.invalidations.flush();
    expect((await summary(user)).json().availableMinorUnits).toBe('500');
  });

  it('recovers worker changes on its periodic recovery tick without a subsequent mutation request', async () => {
    const user = await customer();
    await fund(user);
    primary.invalidations.onModuleInit();
    await vi.waitFor(
      async () => {
        expect(await pending()).toEqual([]);
      },
      { timeout: 3000 },
    );
    expect((await summary(user, secondary)).json().availableMinorUnits).toBe(
      '500',
    );
    // Stop only the periodic timer; the fixture remains readable for cleanup.
    await primary.invalidations.onModuleDestroy();
  });
});
