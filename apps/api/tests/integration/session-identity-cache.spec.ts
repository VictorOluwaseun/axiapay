import { TestRemoteConfigRepository } from '../support/remote-config.js';
import { REMOTE_CONFIG_REPOSITORY } from '../../src/modules/remote-config/remote-config.tokens.js';
import { WALLET_SUMMARY } from '../../src/modules/wallets/wallet-summary.tokens.js';
import { PostgresWalletSummaryInvalidationRepository } from '../../src/modules/wallets/repositories/postgres-wallet-summary-invalidation.repository.js';
import { WalletSummaryInvalidationConnection } from '../../src/infrastructure/database/wallet-summary-invalidation.connection.js';
/** Exercise Redis-only authentication hits, committed outbox delivery and generation-fenced fills with real PostgreSQL/Redis. */
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Test } from '@nestjs/testing';
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
import { SessionCacheInvalidationConnection } from '../../src/infrastructure/database/session-cache-invalidation.connection.js';
import { createDatabase } from '@axiapay/payments-runtime/infrastructure/database/create-database';
import { WalletHttpModule } from '../../src/modules/wallets/wallet-http.module.js';
import { WalletService } from '@axiapay/payments-runtime/modules/wallets/services/wallet.service';
import { DatabaseConnection } from '@axiapay/payments-runtime/infrastructure/database/database.module';
import {
  startWalletTestDatabase,
  type WalletTestDatabase,
} from '../../../../packages/payments-runtime/tests/support/wallet-test-database.js';
import { asyncSignal } from '../../../../packages/payments-runtime/tests/support/async-signal.js';
import { RequestValidationModule } from '../../src/bootstrap/request-validation.module.js';
import { AuthenticationModule } from '../../src/modules/authentication/authentication.module.js';
import { AUTHENTICATION } from '../../src/modules/authentication/authentication.tokens.js';
import { RedisCacheConnection } from '../../src/infrastructure/redis/redis-cache-connection.js';
import { RedisSessionIdentityCache } from '../../src/modules/authentication/data-sources/redis-session-identity-cache.js';
import { PostgresSessionCacheInvalidationRepository } from '../../src/modules/authentication/repositories/postgres-session-cache-invalidation.repository.js';
import { AuthenticationRepositoryImpl } from '../../src/modules/authentication/repositories/authentication.repository.impl.js';
import type { AuthenticationCodeDelivery } from '../../src/modules/authentication/ports/authentication.ports.js';
import type { AuthenticationResult } from '../../src/modules/authentication/services/authentication-session.js';

let database: WalletTestDatabase;
let container: StartedTestContainer;
let connection: RedisCacheConnection;
let cache: RedisSessionIdentityCache;
let invalidations: PostgresSessionCacheInvalidationRepository;
let application: NestFastifyApplication;
let currentTime = new Date('2030-01-01T00:00:00Z');
const deliveredCodes = new Map<string, string>();
const secret = '11'.repeat(32);
const password = 'a longer private passphrase';

/** Compose an independent API, Redis client/cache, invalidation pool and recovery owner against shared authoritative storage. */
async function startReplica(businessDatabase: typeof database.database) {
  const replicaConnection = new RedisCacheConnection(
    new ConfigService({
      REDIS_CACHE_URL: `redis://${container.getHost()}:${container.getMappedPort(6379)}`,
    }),
  );
  await replicaConnection.client.connect();
  const replicaCache = new RedisSessionIdentityCache(replicaConnection, secret);
  const recoveryConnection = new SessionCacheInvalidationConnection(
    new ConfigService({ DATABASE_URL: database.connectionString }),
  );
  const walletRecoveryConnection = new WalletSummaryInvalidationConnection(
    new ConfigService({ DATABASE_URL: database.connectionString }),
  );
  const module = await Test.createTestingModule({
    imports: [RequestValidationModule, AuthenticationModule, WalletHttpModule],
  })
    .overrideProvider(REMOTE_CONFIG_REPOSITORY)
    .useValue(new TestRemoteConfigRepository())
    .overrideProvider(DatabaseConnection)
    .useValue({ database: businessDatabase })
    .overrideProvider(SessionCacheInvalidationConnection)
    .useValue(recoveryConnection)
    .overrideProvider(WalletSummaryInvalidationConnection)
    .useValue(walletRecoveryConnection)
    .overrideProvider(RedisCacheConnection)
    .useValue(replicaConnection)
    .overrideProvider(AUTHENTICATION.sessionIdentityCache)
    .useValue(replicaCache)
    .overrideProvider(AUTHENTICATION.codeDelivery)
    .useValue({
      /** Capture synthetic proof through the delivery port shared by this fixture's API instances. */
      async send(message) {
        deliveredCodes.set(message.challengeId, message.code);
      },
    } satisfies AuthenticationCodeDelivery)
    .overrideProvider(AUTHENTICATION.clock)
    .useValue({
      /** Read controlled business time independently of transport and recovery deadlines. */
      now: () => new Date(currentTime),
    })
    .compile();
  const recovery = module.get<PostgresSessionCacheInvalidationRepository>(
    AUTHENTICATION.sessionCacheInvalidations,
  );
  vi.spyOn(recovery, 'onModuleInit').mockImplementation(() => undefined);
  const walletRecovery =
    module.get<PostgresWalletSummaryInvalidationRepository>(
      WALLET_SUMMARY.invalidations,
    );
  vi.spyOn(walletRecovery, 'onModuleInit').mockImplementation(() => undefined);
  const api = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    { logger: false },
  );
  api.setGlobalPrefix('v1');
  await api.init();
  await api.getHttpAdapter().getInstance().ready();
  await recovery.flush();
  return {
    application: api,
    connection: replicaConnection,
    cache: replicaCache,
    invalidations: recovery,
    recoveryConnection,
  };
}

let replica: Awaited<ReturnType<typeof startReplica>>;
let replicaDatabase: ReturnType<typeof createDatabase>;
let recoveryConnection: SessionCacheInvalidationConnection;

beforeAll(async () => {
  database = await startWalletTestDatabase();
  await sql`grant select, insert, update, delete on auth_accounts, auth_sessions, auth_refresh_tokens, auth_challenges, auth_rate_limits, auth_device_credentials, auth_device_challenges to wallet_runtime`.execute(
    database.administrator,
  );
  await sql`grant select, delete on auth_session_cache_invalidations to wallet_runtime`.execute(
    database.administrator,
  );
  container = await new GenericContainer('redis:8-alpine')
    .withExposedPorts(6379)
    .start();
  const primary = await startReplica(database.database);
  ({ application, connection, cache, invalidations, recoveryConnection } =
    primary);
  replicaDatabase = createDatabase(database.connectionString);
  replica = await startReplica(replicaDatabase);
});

beforeEach(async () => {
  vi.restoreAllMocks();
  currentTime = new Date(currentTime.getTime() + 3_600_000);
  connection.reportRecovery();
  replica.connection.reportRecovery();
  await connection.client.flushdb();
  await invalidations.flush();
  await replica.invalidations.flush();
});

afterAll(async () => {
  await replica?.application.close();
  await replicaDatabase?.destroy();
  await application?.close();
  await container?.stop();
  await database?.stop();
});

/** Send a public auth command; all fixture credentials are synthetic and never appear in public responses. */
function post(route: string, payload: Record<string, unknown>, token?: string) {
  return application.inject({
    method: 'POST',
    url: `/v1/auth/${route}`,
    payload,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

/** Query the protected identity route through its real authentication guard. */
function me(token: string) {
  return application.inject({
    method: 'GET',
    url: '/v1/auth/me',
    headers: { authorization: `Bearer ${token}` },
  });
}

/** Register an independent fixture account and retain its synthetic contact for recovery/login scenarios. */
async function signup() {
  const contact = { kind: 'email', value: `${randomUUID()}@example.com` };
  const challenge = await post('signup', { contact, password });
  expect(challenge.statusCode).toBe(202);
  const challengeId = challenge.json().challengeId as string;
  const response = await post('signup/verify', {
    challengeId,
    code: deliveredCodes.get(challengeId),
  });
  expect(response.statusCode).toBe(201);
  return { ...response.json<AuthenticationResult>(), contact };
}

/** Locate only this isolated Redis database's opaque session key for corruption/race assertions. */
async function cacheKey(token: string): Promise<string> {
  const digest = createHash('sha256').update(token).digest('hex');
  const keys = await connection.client.keys(
    `auth:session:v2:*:identity:${digest}`,
  );
  expect(keys).toHaveLength(1);
  return keys[0]!;
}

describe('session identity cache', () => {
  it('serves Redis-only hits through an independent API, cache client and PostgreSQL pool', async () => {
    const user = await signup();
    expect((await me(user.accessToken)).statusCode).toBe(200);
    expect(replica.cache).not.toBe(cache);
    expect(replica.connection.client).not.toBe(connection.client);
    const query = vi.spyOn(replicaDatabase.getExecutor(), 'executeQuery');
    const response = await replica.application.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(response.json()).toEqual(user.account);
    expect(query).not.toHaveBeenCalled();
  });

  it.each(['logout', 'account-disabled', 'password-reset'] as const)(
    'rejects money-moving writes on another replica after %s even while its cached read still succeeds',
    async (change) => {
      const user = await signup();
      if (change === 'password-reset') {
        currentTime = new Date(currentTime.getTime() + 60_000);
      }
      const headers = { authorization: `Bearer ${user.accessToken}` };
      const read = () =>
        replica.application.inject({
          method: 'GET',
          url: '/v1/auth/me',
          headers,
        });
      expect((await read()).statusCode).toBe(200);
      const transfer = vi.spyOn(
        replica.application.get(WalletService),
        'transferBetweenWallets',
      );
      const provision = vi.spyOn(
        replica.application.get(WalletService),
        'createWallet',
      );
      vi.spyOn(cache, 'invalidate').mockRejectedValue(
        new Error('fixture delivery outage on primary replica'),
      );
      if (change === 'logout') {
        expect((await post('logout', {}, user.accessToken)).statusCode).toBe(
          204,
        );
      }
      if (change === 'account-disabled') {
        await database.administrator
          .updateTable('auth_accounts')
          .set({ disabled_at: currentTime })
          .where('id', '=', user.account.id)
          .execute();
        await invalidations.flush();
      }
      if (change === 'password-reset') {
        currentTime = new Date(currentTime.getTime() + 1_000);
        const requested = await post('password/forgot', {
          contact: user.contact,
        });
        expect(requested.statusCode).toBe(202);
        const challengeId = requested.json().challengeId as string;
        expect(
          (
            await post('password/reset', {
              challengeId,
              code: deliveredCodes.get(challengeId),
              newPassword: 'a different long private passphrase',
            })
          ).statusCode,
        ).toBe(204);
      }
      const query = vi.spyOn(replicaDatabase.getExecutor(), 'executeQuery');
      expect((await read()).statusCode).toBe(200);
      expect(query).not.toHaveBeenCalled();
      const wallet = await database.database
        .selectFrom('wallets')
        .select('id')
        .where('owner_id', '=', user.account.id)
        .where('currency', '=', 'NGN')
        .executeTakeFirstOrThrow();
      const denied = await replica.application.inject({
        method: 'POST',
        url: `/v1/wallets/${wallet.id}/transfers`,
        headers,
        payload: {
          destinationWalletId: randomUUID(),
          currency: 'NGN',
          amountMinorUnits: '1',
          requestKey: randomUUID(),
        },
      });
      expect(denied.statusCode).toBe(401);
      expect(query).toHaveBeenCalled();
      expect(
        (
          await replica.application.inject({
            method: 'POST',
            url: '/v1/wallets',
            headers,
            payload: { currency: 'USD' },
          })
        ).statusCode,
      ).toBe(401);
      expect(transfer).not.toHaveBeenCalled();
      expect(provision).not.toHaveBeenCalled();
      await replica.invalidations.flush();
      expect((await read()).statusCode).toBe(401);
    },
  );

  it('fails protected writes closed during a database outage while cached reads on the same replica still work', async () => {
    const user = await signup();
    expect((await me(user.accessToken)).statusCode).toBe(200);
    const query = vi
      .spyOn(replicaDatabase.getExecutor(), 'executeQuery')
      .mockRejectedValue(new Error('fixture database outage'));
    const headers = { authorization: `Bearer ${user.accessToken}` };
    expect(
      (
        await replica.application.inject({
          method: 'GET',
          url: '/v1/auth/me',
          headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(query).not.toHaveBeenCalled();
    expect(
      (
        await replica.application.inject({
          method: 'POST',
          url: '/v1/wallets',
          headers,
          payload: { currency: 'USD' },
        })
      ).statusCode,
    ).toBe(503);
  });

  it('invalidates another API instance and rejects its delayed stale cache fill after logout', async () => {
    const user = await signup();
    const loaded = asyncSignal();
    const resume = asyncSignal();
    const write = replica.cache.write.bind(replica.cache);
    vi.spyOn(replica.cache, 'write').mockImplementationOnce(async (...args) => {
      loaded.resolve();
      await resume.promise;
      await write(...args);
    });
    const headers = { authorization: `Bearer ${user.accessToken}` };
    const request = Promise.resolve(
      replica.application.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers,
      }),
    );
    try {
      await loaded.promise;
      expect((await post('logout', {}, user.accessToken)).statusCode).toBe(204);
    } finally {
      resume.resolve();
    }
    expect((await request).statusCode).toBe(200);
    expect(
      (
        await replica.application.inject({
          method: 'GET',
          url: '/v1/auth/me',
          headers,
        })
      ).statusCode,
    ).toBe(401);
  });

  it('bounds recovery SQL blocked by a table lock, retains the outbox and resumes after the lock is released', async () => {
    const user = await signup();
    const locked = asyncSignal();
    const release = asyncSignal();
    const held = database.administrator
      .transaction()
      .execute(async (transaction) => {
        await sql`lock table auth_session_cache_state in access exclusive mode`.execute(
          transaction,
        );
        locked.resolve();
        await release.promise;
      });
    await locked.promise;
    try {
      const started = performance.now();
      expect((await post('logout', {}, user.accessToken)).statusCode).toBe(204);
      expect(performance.now() - started).toBeLessThan(800);
      expect(
        (
          await sql`select token_digest from auth_session_cache_invalidations`.execute(
            database.database,
          )
        ).rows.length,
      ).toBeGreaterThan(0);
      expect((await me(user.accessToken)).statusCode).toBe(401);
      await vi.waitFor(async () => {
        const active = await sql<{
          count: number;
        }>`select count(*)::int as count from pg_stat_activity where application_name = 'auth-cache-invalidation' and wait_event_type = 'Lock'`.execute(
          database.administrator,
        );
        expect(active.rows[0]?.count).toBe(0);
      });
    } finally {
      release.resolve();
      await held;
    }
    await invalidations.flush();
    expect(
      (
        await sql`select token_digest from auth_session_cache_invalidations`.execute(
          database.database,
        )
      ).rows,
    ).toEqual([]);
  });

  it('caps the post-commit wait when the isolated recovery pool is exhausted and recovers on a later attempt', async () => {
    const user = await signup();
    const acquired = asyncSignal();
    const release = asyncSignal();
    const held = recoveryConnection.database.connection().execute(async () => {
      acquired.resolve();
      await release.promise;
    });
    await acquired.promise;
    try {
      const started = performance.now();
      expect((await post('logout', {}, user.accessToken)).statusCode).toBe(204);
      expect(performance.now() - started).toBeLessThan(800);
      expect((await me(user.accessToken)).statusCode).toBe(401);
      expect(
        (
          await sql`select token_digest from auth_session_cache_invalidations`.execute(
            database.database,
          )
        ).rows.length,
      ).toBeGreaterThan(0);
    } finally {
      release.resolve();
      await held;
    }
    await invalidations.flush();
    expect(
      (
        await sql`select token_digest from auth_session_cache_invalidations`.execute(
          database.database,
        )
      ).rows,
    ).toEqual([]);
  });

  it('populates on a miss and performs zero PostgreSQL queries on a verified hit across repository instances', async () => {
    const user = await signup();
    expect((await me(user.accessToken)).json()).toEqual(user.account);
    const key = await cacheKey(user.accessToken);
    const encoded = (await connection.client.get(key))!;
    const payload = JSON.parse(JSON.parse(encoded).payload);
    expect(payload.identity).toEqual(user.account);
    expect(payload).not.toHaveProperty('passwordHash');
    expect(encoded).not.toContain(user.accessToken);
    expect(encoded).not.toContain('argon2');
    expect(await connection.client.pttl(key)).toBeGreaterThan(0);
    expect(await connection.client.pttl(key)).toBeLessThanOrEqual(60_000);
    const query = vi.spyOn(database.database.getExecutor(), 'executeQuery');
    expect((await me(user.accessToken)).statusCode).toBe(200);
    expect(query).not.toHaveBeenCalled();
    const replica = new AuthenticationRepositoryImpl(
      database.database,
      cache,
      invalidations,
    );
    expect(
      await replica.findSessionIdentity(
        createHash('sha256').update(user.accessToken).digest('hex'),
        currentTime,
      ),
    ).toEqual(user.account);
    expect(query).not.toHaveBeenCalled();
  });

  it('invalidates cached logout immediately even if an old cache value is restored afterward', async () => {
    const user = await signup();
    expect((await me(user.accessToken)).statusCode).toBe(200);
    const key = await cacheKey(user.accessToken);
    const stale = (await connection.client.get(key))!;
    expect((await post('logout', {}, user.accessToken)).statusCode).toBe(204);
    await connection.client.set(key, stale, 'EX', 60);
    expect((await me(user.accessToken)).statusCode).toBe(401);
  });

  it('deletes only affected entries and leaves another account on the Redis-only hit path', async () => {
    const user = await signup();
    const other = await signup();
    expect((await me(user.accessToken)).statusCode).toBe(200);
    expect((await me(other.accessToken)).statusCode).toBe(200);
    const key = await cacheKey(user.accessToken);
    const otherKey = await cacheKey(other.accessToken);
    const otherPayload = await connection.client.get(otherKey);
    expect((await post('logout', {}, user.accessToken)).statusCode).toBe(204);
    expect(await connection.client.get(key)).toBeNull();
    expect(await connection.client.get(otherKey)).toBe(otherPayload);
    const query = vi.spyOn(database.database.getExecutor(), 'executeQuery');
    expect((await me(other.accessToken)).statusCode).toBe(200);
    expect(query).not.toHaveBeenCalled();
  });

  it('retains failed invalidations durably and recovers them automatically after restart', async () => {
    const user = await signup();
    expect((await me(user.accessToken)).statusCode).toBe(200);
    const key = await cacheKey(user.accessToken);
    const failure = vi
      .spyOn(cache, 'invalidate')
      .mockRejectedValue(new Error('fixture invalidation outage'));
    expect((await post('logout', {}, user.accessToken)).statusCode).toBe(204);
    const pending = await sql<{
      token_digest: string;
    }>`select token_digest from auth_session_cache_invalidations`.execute(
      database.database,
    );
    expect(pending.rows).toContainEqual({
      token_digest: createHash('sha256').update(user.accessToken).digest('hex'),
    });
    expect(await connection.client.get(key)).not.toBeNull();
    expect((await me(user.accessToken)).statusCode).toBe(401);
    const recovery = new PostgresSessionCacheInvalidationRepository(
      database.database,
      cache,
    );
    recovery.onModuleInit();
    try {
      await recovery.flush();
      failure.mockRestore();
      await vi.waitFor(
        async () => {
          expect(
            (
              await sql`select token_digest from auth_session_cache_invalidations`.execute(
                database.database,
              )
            ).rows,
          ).toEqual([]);
        },
        { timeout: 3_000, interval: 25 },
      );
      expect(await connection.client.get(key)).toBeNull();
      expect((await me(user.accessToken)).statusCode).toBe(401);
    } finally {
      await recovery.onModuleDestroy();
    }
  });

  it('does not acknowledge a newer event committed while an older invalidation is being delivered', async () => {
    const user = await signup();
    expect((await me(user.accessToken)).statusCode).toBe(200);
    await database.administrator
      .updateTable('auth_accounts')
      .set({ contact_value: `${randomUUID()}@example.com` })
      .where('id', '=', user.account.id)
      .execute();
    const invalidate = cache.invalidate.bind(cache);
    const changedContact = `${randomUUID()}@example.com`;
    const delivery = vi
      .spyOn(cache, 'invalidate')
      .mockImplementationOnce(async (...args) => {
        await invalidate(...args);
        await database.administrator
          .updateTable('auth_accounts')
          .set({ contact_value: changedContact })
          .where('id', '=', user.account.id)
          .execute();
      });
    await invalidations.flush();
    expect(delivery).toHaveBeenCalledTimes(2);
    expect(
      (
        await sql`select token_digest from auth_session_cache_invalidations`.execute(
          database.database,
        )
      ).rows,
    ).toEqual([]);
    expect((await me(user.accessToken)).json().contact.value).toBe(
      changedContact,
    );
  });

  it.each(['retained', 'evicted', 'reset'])(
    'rejects a delayed stale fill when its Redis fence is %s',
    async (scenario) => {
      const user = await signup();
      const loaded = asyncSignal();
      const resume = asyncSignal();
      const write = cache.write.bind(cache);
      vi.spyOn(cache, 'write').mockImplementationOnce(async (...args) => {
        loaded.resolve();
        await resume.promise;
        await write(...args);
      });
      const inFlight = me(user.accessToken);
      // Fastify's injection is lazy until its thenable is consumed.
      const result = Promise.resolve(inFlight);
      try {
        await loaded.promise;
        expect((await post('logout', {}, user.accessToken)).statusCode).toBe(
          204,
        );
        const digest = createHash('sha256')
          .update(user.accessToken)
          .digest('hex');
        if (scenario === 'evicted') {
          await connection.client.del(
            ...(await connection.client.keys(
              `auth:session:v2:*:fence:${digest}`,
            )),
          );
        }
        if (scenario === 'reset') {
          await connection.client.flushdb();
        }
      } finally {
        resume.resolve();
      }
      expect((await result).statusCode).toBe(200);
      expect((await me(user.accessToken)).statusCode).toBe(401);
    },
  );

  it('rolls back a mutation when its durable invalidation cannot be recorded', async () => {
    const user = await signup();
    expect((await me(user.accessToken)).statusCode).toBe(200);
    await sql`alter table auth_session_cache_invalidations add constraint fixture_block_outbox check (false) not valid`.execute(
      database.administrator,
    );
    try {
      expect((await post('logout', {}, user.accessToken)).statusCode).toBe(503);
      expect(
        (
          await database.administrator
            .selectFrom('auth_sessions')
            .select('revoked_at')
            .where('account_id', '=', user.account.id)
            .executeTakeFirstOrThrow()
        ).revoked_at,
      ).toBeNull();
      expect((await me(user.accessToken)).statusCode).toBe(200);
    } finally {
      await sql`alter table auth_session_cache_invalidations drop constraint fixture_block_outbox`.execute(
        database.administrator,
      );
    }
  });

  it('invalidates every cached account session on password recovery', async () => {
    const user = await signup();
    const login = await post('login/password', {
      contact: user.contact,
      password,
    });
    expect(login.statusCode).toBe(200);
    const secondToken = login.json().accessToken as string;
    expect((await me(user.accessToken)).statusCode).toBe(200);
    expect((await me(secondToken)).statusCode).toBe(200);
    currentTime = new Date(currentTime.getTime() + 60_000);
    const challenge = await post('password/forgot', { contact: user.contact });
    expect(challenge.statusCode).toBe(202);
    const challengeId = challenge.json().challengeId as string;
    expect(
      (
        await post('password/reset', {
          challengeId,
          code: deliveredCodes.get(challengeId),
          newPassword: 'another longer private passphrase',
        })
      ).statusCode,
    ).toBe(204);
    expect((await me(user.accessToken)).statusCode).toBe(401);
    expect((await me(secondToken)).statusCode).toBe(401);
  });

  it('invalidates revoked device sessions while preserving the primary session', async () => {
    const user = await signup();
    const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const challenge = await post(
      'devices/enrollment/challenge',
      {
        deviceName: 'Fixture phone',
        publicKey: key.publicKey
          .export({ type: 'spki', format: 'der' })
          .toString('base64url'),
      },
      user.accessToken,
    );
    expect(challenge.statusCode).toBe(200);
    const enrollment = challenge.json();
    const enrolled = await post(
      'devices/enrollment/verify',
      {
        challengeId: enrollment.challengeId,
        credentialId: enrollment.credentialId,
        signature: sign(
          'sha256',
          Buffer.from(enrollment.message, 'base64url'),
          key.privateKey,
        ).toString('base64url'),
      },
      user.accessToken,
    );
    expect(enrolled.statusCode).toBe(201);
    const loginChallenge = await post('login/device/challenge', {
      credentialId: enrollment.credentialId,
    });
    expect(loginChallenge.statusCode).toBe(200);
    const proof = loginChallenge.json();
    const login = await post('login/device/verify', {
      challengeId: proof.challengeId,
      credentialId: proof.credentialId,
      signature: sign(
        'sha256',
        Buffer.from(proof.message, 'base64url'),
        key.privateKey,
      ).toString('base64url'),
    });
    expect(login.statusCode).toBe(200);
    const deviceToken = login.json().accessToken as string;
    expect((await me(deviceToken)).statusCode).toBe(200);
    expect((await me(user.accessToken)).statusCode).toBe(200);
    const revoked = await application.inject({
      method: 'DELETE',
      url: `/v1/auth/devices/${enrollment.credentialId}`,
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(revoked.statusCode).toBe(204);
    expect((await me(deviceToken)).statusCode).toBe(401);
    expect((await me(user.accessToken)).statusCode).toBe(200);
  });

  it('invalidates direct administrative disable/contact changes and keeps rolled-back mutations invisible', async () => {
    const user = await signup();
    expect((await me(user.accessToken)).statusCode).toBe(200);
    const before = await sql<{
      count: string;
    }>`select count(*)::text as count from auth_session_cache_invalidations`.execute(
      database.database,
    );
    await expect(
      database.administrator.transaction().execute(async (transaction) => {
        await transaction
          .updateTable('auth_accounts')
          .set({ disabled_at: currentTime })
          .where('id', '=', user.account.id)
          .execute();
        throw new Error('fixture rollback');
      }),
    ).rejects.toThrow('fixture rollback');
    expect(
      (
        await sql<{
          count: string;
        }>`select count(*)::text as count from auth_session_cache_invalidations`.execute(
          database.database,
        )
      ).rows,
    ).toEqual(before.rows);
    expect((await me(user.accessToken)).statusCode).toBe(200);
    await database.administrator
      .updateTable('auth_accounts')
      .set({ disabled_at: currentTime })
      .where('id', '=', user.account.id)
      .execute();
    await invalidations.flush();
    expect((await me(user.accessToken)).statusCode).toBe(401);
    await database.administrator
      .updateTable('auth_accounts')
      .set({ disabled_at: null, contact_value: `${randomUUID()}@example.com` })
      .where('id', '=', user.account.id)
      .execute();
    await invalidations.flush();
    const identity = await me(user.accessToken);
    expect(identity.statusCode).toBe(200);
    expect(identity.json().contact.value).not.toBe(user.contact.value);
  });

  it('caps cache lifetime at session expiry and rejects a still-present expired snapshot', async () => {
    const user = await signup();
    await database.administrator
      .updateTable('auth_sessions')
      .set({ expires_at: new Date(currentTime.getTime() + 500) })
      .where('account_id', '=', user.account.id)
      .execute();
    expect((await me(user.accessToken)).statusCode).toBe(200);
    const key = await cacheKey(user.accessToken);
    expect(await connection.client.pttl(key)).toBeLessThanOrEqual(500);
    currentTime = new Date(currentTime.getTime() + 500);
    expect((await me(user.accessToken)).statusCode).toBe(401);
  });

  it('rejects malformed/tampered/copied records and reloads trusted identity from PostgreSQL', async () => {
    const user = await signup();
    const other = await signup();
    expect((await me(user.accessToken)).statusCode).toBe(200);
    expect((await me(other.accessToken)).statusCode).toBe(200);
    const key = await cacheKey(user.accessToken);
    const otherKey = await cacheKey(other.accessToken);
    const encoded = (await connection.client.get(key))!;
    for (const corrupt of [
      '{',
      JSON.stringify({ payload: '{}', mac: 'a'.repeat(64) }),
      (await connection.client.get(otherKey))!,
    ]) {
      await connection.client.set(key, corrupt, 'EX', 60);
      expect((await me(user.accessToken)).json()).toEqual(user.account);
    }
    const envelope = JSON.parse(encoded);
    const snapshot = JSON.parse(envelope.payload);
    snapshot.identity.id = other.account.id;
    await connection.client.set(
      key,
      JSON.stringify({ ...envelope, payload: JSON.stringify(snapshot) }),
      'EX',
      60,
    );
    expect((await me(user.accessToken)).json()).toEqual(user.account);
    const failedWrite = vi
      .spyOn(cache, 'write')
      .mockImplementationOnce(async () => {
        connection.reportFailure();
        cache.pause();
      });
    await connection.client.del(key);
    expect((await me(user.accessToken)).statusCode).toBe(200);
    expect(failedWrite).toHaveBeenCalled();
  });

  it('serves cache hits without PostgreSQL and fails on a database miss when PostgreSQL is unavailable', async () => {
    const user = await signup();
    expect((await me(user.accessToken)).statusCode).toBe(200);
    const query = vi
      .spyOn(database.database.getExecutor(), 'executeQuery')
      .mockRejectedValue(new Error('fixture database outage'));
    expect((await me(user.accessToken)).statusCode).toBe(200);
    expect(query).not.toHaveBeenCalled();
    await connection.client.del(await cacheKey(user.accessToken));
    expect((await me(user.accessToken)).statusCode).toBe(503);
  });

  it('keeps transaction-local revocation out of Redis and preserves the original cache on rollback', async () => {
    const user = await signup();
    expect((await me(user.accessToken)).statusCode).toBe(200);
    const digest = createHash('sha256').update(user.accessToken).digest('hex');
    const write = vi.spyOn(cache, 'write');
    const repository = new AuthenticationRepositoryImpl(
      database.database,
      cache,
    );
    await expect(
      repository.transaction(async (transaction) => {
        await transaction.revokeSession(digest, currentTime);
        expect(
          await transaction.findSessionIdentity(digest, currentTime),
        ).toBeNull();
        throw new Error('fixture rollback');
      }),
    ).rejects.toThrow('fixture rollback');
    expect((await me(user.accessToken)).statusCode).toBe(200);
    expect(write).not.toHaveBeenCalled();
    await expect(
      sql`update auth_session_cache_state set namespace = gen_random_uuid()`.execute(
        database.database,
      ),
    ).rejects.toThrow('permission denied');
  });

  it('falls back during a real Redis disconnect and rejects revoked sessions after reconnection', async () => {
    const user = await signup();
    expect((await me(user.accessToken)).statusCode).toBe(200);
    connection.client.disconnect();
    try {
      expect((await me(user.accessToken)).statusCode).toBe(200);
      expect((await post('logout', {}, user.accessToken)).statusCode).toBe(204);
      expect((await me(user.accessToken)).statusCode).toBe(401);
    } finally {
      await connection.client.connect();
      await invalidations.flush();
    }
    expect((await me(user.accessToken)).statusCode).toBe(401);
  });

  it('resets restored stale Redis state on reconnect even after the outbox event was acknowledged', async () => {
    const user = await signup();
    expect((await me(user.accessToken)).statusCode).toBe(200);
    const key = await cacheKey(user.accessToken);
    const digest = createHash('sha256').update(user.accessToken).digest('hex');
    const fence = (
      await connection.client.keys(`auth:session:v2:*:fence:${digest}`)
    )[0]!;
    const epochKey = key.slice(0, key.indexOf('identity:')) + 'epoch';
    const oldEpoch = (await connection.client.get(epochKey))!;
    const oldFence = await connection.client.hgetall(fence);
    const oldPayload = (await connection.client.get(key))!;
    expect((await post('logout', {}, user.accessToken)).statusCode).toBe(204);
    expect(
      (
        await sql`select token_digest from auth_session_cache_invalidations`.execute(
          database.database,
        )
      ).rows,
    ).toEqual([]);
    connection.client.disconnect();
    await vi.waitFor(() => expect(connection.client.status).toBe('end'));
    await connection.client.connect();
    // Simulate cache persistence/failover returning an earlier acknowledged cache snapshot.
    await connection.client.set(epochKey, oldEpoch);
    await connection.client.hset(fence, oldFence);
    await connection.client.set(key, oldPayload, 'EX', 60);
    await invalidations.flush();
    expect((await me(user.accessToken)).statusCode).toBe(401);
  });

  it('bounds an unresponsive Redis command and continues authenticating against PostgreSQL', async () => {
    const user = await signup();
    expect((await me(user.accessToken)).statusCode).toBe(200);
    await connection.client.call('CLIENT', 'PAUSE', '500', 'ALL');
    const started = performance.now();
    expect((await me(user.accessToken)).statusCode).toBe(200);
    expect(performance.now() - started).toBeLessThan(450);
    // Drain the deliberately paused fixture before the next test/teardown.
    const control = connection.client.duplicate({
      lazyConnect: false,
      enableOfflineQueue: true,
      commandTimeout: 2_000,
    });
    try {
      await control.ping();
    } finally {
      control.disconnect();
    }
  });
});

/** Rotation changes the family in SQL while Redis invalidation reaches independent read replicas. */
describe('refresh rotation across independent API and cache instances', () => {
  it('invalidates the earlier access token and commits replay revocation across replicas', async () => {
    const user = await signup();
    expect((await me(user.accessToken)).statusCode).toBe(200);
    const rotated = await replica.application.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: user.refreshToken },
    });
    expect(rotated.statusCode).toBe(200);
    const next = rotated.json<AuthenticationResult>();
    expect((await me(user.accessToken)).statusCode).toBe(401);
    expect((await me(next.accessToken)).statusCode).toBe(200);
    const replay = await post('refresh', { refreshToken: user.refreshToken });
    expect(replay.statusCode).toBe(401);
    const invalid = await replica.application.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${next.accessToken}` },
    });
    expect(invalid.statusCode).toBe(401);
    expect(
      (await post('refresh', { refreshToken: next.refreshToken })).statusCode,
    ).toBe(401);
  });

  it('serializes a refresh proof used simultaneously by different API processes', async () => {
    const user = await signup();
    const responses = await Promise.all([
      post('refresh', { refreshToken: user.refreshToken }),
      replica.application.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: user.refreshToken },
      }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 401,
    ]);
    const winner = responses
      .find((response) => response.statusCode === 200)!
      .json<AuthenticationResult>();
    expect((await me(winner.accessToken)).statusCode).toBe(401);
  });
});
