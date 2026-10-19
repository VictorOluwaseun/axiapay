import { SessionCacheInvalidationConnection } from '../../src/infrastructure/database/session-cache-invalidation.connection.js';
import { asyncSignal } from '../../../../packages/payments-runtime/tests/support/async-signal.js';
/** Exercise public authentication flows and concurrency against an isolated PostgreSQL database. */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { randomUUID } from 'node:crypto';
import { ArgonPasswordHasher } from '../../src/modules/authentication/security/argon-password-hasher.js';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { sql, type Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import {
  createDatabase,
  type DatabaseSchema,
} from '@axiapay/payments-runtime/infrastructure/database/create-database';
import { WalletDataSource } from '@axiapay/payments-runtime/modules/wallets/data-sources/wallet.data-source';
import { NodeAuthenticationSecrets } from '../../src/modules/authentication/security/node-authentication-secrets.js';
import { AuthenticationModule } from '../../src/modules/authentication/authentication.module.js';
import { DatabaseConnection } from '@axiapay/payments-runtime/infrastructure/database/database.module';
import { RequestValidationModule } from '../../src/bootstrap/request-validation.module.js';
import { AUTHENTICATION } from '../../src/modules/authentication/authentication.tokens.js';
import { AuthenticationRepositoryImpl } from '../../src/modules/authentication/repositories/authentication.repository.impl.js';
import type { AuthenticationCodeDelivery } from '../../src/modules/authentication/ports/authentication.ports.js';
import type { AuthenticationResult } from '../../src/modules/authentication/services/authentication-session.js';
import type { Contact } from '../../src/modules/authentication/domain/authentication-models.js';
import { TestRemoteConfigRepository } from '../support/remote-config.js';
import { REMOTE_CONFIG_REPOSITORY } from '../../src/modules/remote-config/remote-config.tokens.js';
import {
  remoteConfigFlagKeys,
  type RemoteConfigFlagKey,
} from '../../src/modules/remote-config/domain/remote-config.js';

/** Capture test-only deliveries through the real code-delivery port, without exposing codes in the HTTP contract. */
class CapturedCodeDelivery implements AuthenticationCodeDelivery {
  messages: Parameters<AuthenticationCodeDelivery['send']>[0][] = [];
  fail = false;
  /** Simulate provider acceptance or failure deterministically. */
  async send(
    message: Parameters<AuthenticationCodeDelivery['send']>[0],
  ): Promise<void> {
    if (this.fail) {
      throw new Error('simulated provider rejection');
    }
    this.messages.push(message);
  }
  /** Retrieve the secret a test recipient would receive; unknown challenge IDs fail the test immediately. */
  codeFor(id: string): string {
    const message = this.messages.find((entry) => entry.challengeId === id);
    if (!message) {
      throw new Error('No captured code for this challenge.');
    }
    return message.code;
  }
}

let container: StartedPostgreSqlContainer;
let database: Kysely<DatabaseSchema>;
let application: NestFastifyApplication;
let currentTime = new Date();
let initialWalletCount = 0;
let initialLedgerAccountCount = 0;
let initialLedgerBalanceCount = 0;
const clock = {
  /** Expose test time without changing global timers or database clocks. */ now: () =>
    new Date(currentTime),
};
const delivery = new CapturedCodeDelivery();
const remoteConfig = new TestRemoteConfigRepository();
const email: Contact = { kind: 'email', value: 'alice@example.com' };
const phone: Contact = { kind: 'phone', value: '+2348012345678' };
const password = 'a longer private passphrase';

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').start();
  database = createDatabase(container.getConnectionUri());
  const migrationPath = new URL(
    '../../migrations/202610130000-authentication.js',
    import.meta.url,
  ).href;
  const migrator = new Migrator({
    db: database,
    provider: {
      /** Include the ledger because verified signup provisions its wallet in the identity transaction. */ getMigrations:
        async () => ({
          authentication: await import(migrationPath),
          sessionInvalidations: await import(
            new URL(
              '../../migrations/202610160014-auth-session-cache-invalidation.js',
              import.meta.url,
            ).href
          ),
          refreshTokens: await import(
            new URL(
              '../../migrations/202610190018-authentication-refresh-tokens.js',
              import.meta.url,
            ).href
          ),
          sessionCache: await import(
            new URL(
              '../../migrations/202610160013-authentication-session-cache.js',
              import.meta.url,
            ).href
          ),
          walletLedger: await import(
            new URL(
              '../../migrations/202610130001-wallet-ledger.js',
              import.meta.url,
            ).href
          ),
          deviceAuthentication: await import(
            new URL(
              '../../migrations/202610130003-device-authentication.js',
              import.meta.url,
            ).href
          ),
          passwordRecovery: await import(
            new URL(
              '../../migrations/202610150010-password-recovery.js',
              import.meta.url,
            ).href
          ),
        }),
    },
  });
  const { error } = await migrator.migrateToLatest();
  if (error) {
    throw error;
  }
  const module = await Test.createTestingModule({
    imports: [RequestValidationModule, AuthenticationModule],
  })
    .overrideProvider(REMOTE_CONFIG_REPOSITORY)
    .useValue(remoteConfig)
    .overrideProvider(DatabaseConnection)
    .useValue({ database })
    .overrideProvider(SessionCacheInvalidationConnection)
    .useValue({ database })
    .overrideProvider(AUTHENTICATION.codeDelivery)
    .useValue(delivery)
    .overrideProvider(AUTHENTICATION.clock)
    .useValue(clock)
    .compile();
  application = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    { logger: false },
  );
  application.setGlobalPrefix('v1');
  await application.init();
  await application.getHttpAdapter().getInstance().ready();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await sql`truncate auth_sessions, auth_accounts, auth_challenges, auth_rate_limits cascade`.execute(
    database,
  );
  remoteConfig.reset();
  // Keep immutable ledger history; compare provisioning against this test's starting snapshot.
  initialWalletCount = (
    await database.selectFrom('wallets').select('id').execute()
  ).length;
  initialLedgerAccountCount = (
    await database.selectFrom('ledger_accounts').select('id').execute()
  ).length;
  initialLedgerBalanceCount = (
    await database.selectFrom('ledger_balances').select('account_id').execute()
  ).length;
  currentTime = new Date('2030-01-01T00:00:00Z');
  delivery.messages = [];
  delivery.fail = false;
});
afterAll(async () => {
  await application?.close();
  await database?.destroy();
  await container?.stop();
});

/** Advance business time to test resend and expiry boundaries without real sleeps. */
function advance(seconds: number): void {
  currentTime = new Date(currentTime.getTime() + seconds * 1000);
}
/** Call a public authentication route with a JSON body. */
function post(route: string, payload: Record<string, unknown>) {
  return application.inject({
    method: 'POST',
    url: `/v1/auth/${route}`,
    payload,
  });
}
/** Complete contact verification through the public endpoints. */
async function signup(
  contact: Contact,
  selectedPassword?: string,
): Promise<AuthenticationResult> {
  const request = await post('signup', {
    contact,
    ...(selectedPassword === undefined ? {} : { password: selectedPassword }),
  });
  expect(request.statusCode).toBe(202);
  const challengeId = request.json().challengeId as string;
  const verification = await post('signup/verify', {
    challengeId,
    code: delivery.codeFor(challengeId),
  });
  expect(verification.statusCode).toBe(201);
  return verification.json<AuthenticationResult>();
}
/** Read protected identity with a supplied opaque token. */
function me(token: string) {
  return application.inject({
    method: 'GET',
    url: '/v1/auth/me',
    headers: { authorization: `Bearer ${token}` },
  });
}

/** Publish one test policy change without restarting the application or touching authentication storage. */
async function setFlag(
  key: RemoteConfigFlagKey,
  enabled: boolean,
): Promise<void> {
  remoteConfig.setFlag(key, enabled);
}

describe('remote authentication configuration', () => {
  it('publishes a versioned policy without authentication', async () => {
    const response = await application.inject({
      method: 'GET',
      url: '/v1/config',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe(
      'private, no-cache, must-revalidate',
    );
    expect(response.headers.etag).toBe(`"${response.json().version}"`);
    expect(response.json()).toEqual({
      version: expect.stringMatching(/^rc1-[a-f0-9]{64}$/),
      features: {
        airtime: { enabled: true },
        data: { enabled: true },
        electricity: { enabled: true },
        tv: { enabled: true },
        education: { enabled: true },
        insurance: { enabled: true },
        bankTransfer: { enabled: true },
        merchant: { enabled: true },
        airtimeConversion: { enabled: true },
      },
      authentication: {
        signup: {
          emailEnabled: true,
          phoneEnabled: true,
          passwordEnabled: true,
          otpEnabled: true,
        },
        login: {
          emailEnabled: true,
          phoneEnabled: true,
          passwordEnabled: true,
          otpEnabled: true,
        },
      },
    });
  });

  it.each([
    {
      operation: 'signup',
      contact: email,
      otherContact: phone,
      key: remoteConfigFlagKeys.signupEmail,
    },
    {
      operation: 'signup',
      contact: phone,
      otherContact: email,
      key: remoteConfigFlagKeys.signupPhone,
    },
    {
      operation: 'login',
      contact: email,
      otherContact: phone,
      key: remoteConfigFlagKeys.loginEmail,
    },
    {
      operation: 'login',
      contact: phone,
      otherContact: email,
      key: remoteConfigFlagKeys.loginPhone,
    },
  ] as const)(
    'applies $key independently before issuing a code or hashing a password',
    async ({ operation, contact, otherContact, key }) => {
      await setFlag(key, false);
      const hash = vi.spyOn(ArgonPasswordHasher.prototype, 'hash');
      const route = operation === 'signup' ? 'signup' : 'login/code';
      const rejected = await post(route, {
        contact,
        ...(operation === 'signup' ? { password } : {}),
      });
      expect(rejected.statusCode).toBe(403);
      expect(rejected.json().code).toBe('AUTHENTICATION_METHOD_DISABLED');
      expect(delivery.messages).toHaveLength(0);
      expect(hash).not.toHaveBeenCalled();
      expect(
        await database.selectFrom('auth_challenges').selectAll().execute(),
      ).toHaveLength(0);
      expect(
        await database.selectFrom('auth_rate_limits').selectAll().execute(),
      ).toHaveLength(0);

      const configuration = await application.inject({
        method: 'GET',
        url: '/v1/config',
      });
      const property =
        contact.kind === 'email' ? 'emailEnabled' : 'phoneEnabled';
      expect(configuration.json().authentication[operation][property]).toBe(
        false,
      );
      expect((await post(route, { contact: otherContact })).statusCode).toBe(
        202,
      );
      const otherRoute = operation === 'signup' ? 'login/code' : 'signup';
      expect((await post(otherRoute, { contact })).statusCode).toBe(202);
    },
  );

  it.each([
    {
      operation: 'signup',
      credential: 'password',
      key: remoteConfigFlagKeys.signupPassword,
    },
    {
      operation: 'signup',
      credential: 'otp',
      key: remoteConfigFlagKeys.signupOtp,
    },
    {
      operation: 'login',
      credential: 'password',
      key: remoteConfigFlagKeys.loginPassword,
    },
    {
      operation: 'login',
      credential: 'otp',
      key: remoteConfigFlagKeys.loginOtp,
    },
  ] as const)(
    'rejects disabled $operation $credential before hashing, delivery or account lookup',
    async ({ operation, credential, key }) => {
      await setFlag(key, false);
      const hash = vi.spyOn(ArgonPasswordHasher.prototype, 'hash');
      const verify = vi.spyOn(ArgonPasswordHasher.prototype, 'verify');
      const route =
        operation === 'signup'
          ? 'signup'
          : credential === 'password'
            ? 'login/password'
            : 'login/code';
      for (const contact of [email, phone]) {
        const rejected = await post(route, {
          contact,
          ...(credential === 'password' ? { password } : {}),
        });
        expect(rejected.statusCode).toBe(403);
        expect(rejected.json().code).toBe('AUTHENTICATION_METHOD_DISABLED');
      }
      expect(hash).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
      expect(delivery.messages).toHaveLength(0);
      expect(
        await database.selectFrom('auth_challenges').selectAll().execute(),
      ).toHaveLength(0);
      expect(
        await database.selectFrom('auth_rate_limits').selectAll().execute(),
      ).toHaveLength(0);
    },
  );

  it.each([email, phone])(
    'keeps mandatory contact proof for password $kind signup when passwordless OTP signup is disabled',
    async (contact) => {
      await setFlag(remoteConfigFlagKeys.signupOtp, false);
      const session = await signup(contact, password);
      expect(session.account.contact).toEqual(contact);
      expect(delivery.messages).toHaveLength(1);
      expect(
        await database
          .selectFrom('wallets')
          .where('owner_id', '=', session.account.id)
          .select('id')
          .execute(),
      ).toHaveLength(1);
      expect(
        (await post('login/password', { contact, password })).statusCode,
      ).toBe(200);
    },
  );

  it.each([
    {
      operation: 'signup',
      credential: 'password',
      key: remoteConfigFlagKeys.signupPassword,
    },
    {
      operation: 'signup',
      credential: 'otp',
      key: remoteConfigFlagKeys.signupOtp,
    },
    {
      operation: 'login',
      credential: 'otp',
      key: remoteConfigFlagKeys.loginOtp,
    },
  ] as const)(
    'rechecks issued $operation $credential proof and retains it when the method becomes disabled',
    async ({ operation, credential, key }) => {
      if (operation === 'login') {
        await signup(email, password);
        advance(60);
      }
      const requested = await post(
        operation === 'signup' ? 'signup' : 'login/code',
        {
          contact: email,
          ...(credential === 'password' ? { password } : {}),
        },
      );
      expect(requested.statusCode).toBe(202);
      const challengeId = requested.json().challengeId as string;
      const verification = { challengeId, code: delivery.codeFor(challengeId) };
      await setFlag(key, false);
      const before = await database
        .selectFrom('auth_sessions')
        .select('id')
        .execute();
      const route =
        operation === 'signup' ? 'signup/verify' : 'login/code/verify';
      const rejected = await post(route, verification);
      expect(rejected.statusCode).toBe(403);
      expect(rejected.json().code).toBe('AUTHENTICATION_METHOD_DISABLED');
      expect(
        await database
          .selectFrom('auth_challenges')
          .where('id', '=', challengeId)
          .select('status')
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: 'ready' });
      expect(
        await database.selectFrom('auth_sessions').select('id').execute(),
      ).toEqual(before);
      expect(
        await database.selectFrom('wallets').select('id').execute(),
      ).toHaveLength(initialWalletCount + (operation === 'login' ? 1 : 0));
      await setFlag(key, true);
      expect((await post(route, verification)).statusCode).toBe(
        operation === 'signup' ? 201 : 200,
      );
    },
  );

  it.each([email, phone])(
    'rechecks disabled $kind signup when redeeming an issued code and preserves its proof',
    async (contact) => {
      const requested = await post('signup', { contact });
      const challengeId = requested.json().challengeId as string;
      const verification = { challengeId, code: delivery.codeFor(challengeId) };
      const key =
        contact.kind === 'email'
          ? remoteConfigFlagKeys.signupEmail
          : remoteConfigFlagKeys.signupPhone;
      await setFlag(key, false);
      const rejected = await post('signup/verify', verification);
      expect(rejected.statusCode).toBe(403);
      expect(rejected.json().code).toBe('AUTHENTICATION_METHOD_DISABLED');
      expect(
        await database.selectFrom('auth_accounts').selectAll().execute(),
      ).toHaveLength(0);
      expect(
        await database.selectFrom('auth_sessions').selectAll().execute(),
      ).toHaveLength(0);
      expect(
        await database.selectFrom('wallets').selectAll().execute(),
      ).toHaveLength(initialWalletCount);
      expect(
        await database
          .selectFrom('auth_challenges')
          .select('status')
          .where('id', '=', challengeId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: 'ready' });
      await setFlag(key, true);
      expect((await post('signup/verify', verification)).statusCode).toBe(201);
    },
  );

  it.each([email, phone])(
    'disables $kind password and code login while preserving other methods and existing sessions',
    async (contact) => {
      const session = await signup(contact, password);
      advance(60);
      const requested = await post('login/code', { contact });
      const challengeId = requested.json().challengeId as string;
      const verification = { challengeId, code: delivery.codeFor(challengeId) };
      const key =
        contact.kind === 'email'
          ? remoteConfigFlagKeys.loginEmail
          : remoteConfigFlagKeys.loginPhone;
      await setFlag(key, false);
      const verifyPassword = vi.spyOn(ArgonPasswordHasher.prototype, 'verify');
      for (const [route, payload] of [
        ['login/password', { contact, password }],
        ['login/code', { contact }],
        ['login/code/verify', verification],
      ] as const) {
        const rejected = await post(route, payload);
        expect(rejected.statusCode).toBe(403);
        expect(rejected.json().code).toBe('AUTHENTICATION_METHOD_DISABLED');
      }
      expect(verifyPassword).not.toHaveBeenCalled();
      expect((await me(session.accessToken)).statusCode).toBe(200);
      expect(
        await database.selectFrom('auth_sessions').select('id').execute(),
      ).toHaveLength(1);
      await setFlag(key, true);
      expect((await post('login/code/verify', verification)).statusCode).toBe(
        200,
      );
      expect(
        (await post('login/password', { contact, password })).statusCode,
      ).toBe(200);
    },
  );

  it.each([email, phone])(
    'keeps $kind recovery available with all signup and login methods disabled',
    async (contact) => {
      await signup(contact, password);
      advance(60);
      for (const key of Object.values(remoteConfigFlagKeys)) {
        await setFlag(key, false);
      }
      const requested = await post('password/forgot', { contact });
      expect(requested.statusCode).toBe(202);
      const challengeId = requested.json().challengeId as string;
      const response = await post('password/reset', {
        challengeId,
        code: delivery.codeFor(challengeId),
        newPassword: 'a different long private passphrase',
      });
      expect(response.statusCode).toBe(204);
      expect(
        (await post('login/password', { contact, password })).statusCode,
      ).toBe(403);
    },
  );

  it('fails safely when no current config exists without consuming an issued code or leaking provider errors', async () => {
    const requested = await post('signup', { contact: email });
    const challengeId = requested.json().challengeId as string;
    vi.spyOn(remoteConfig, 'getFlags').mockRejectedValue(
      new Error('private Firebase credential details'),
    );
    for (const response of [
      await application.inject({ method: 'GET', url: '/v1/config' }),
      await post('signup', { contact: phone }),
      await post('login/password', { contact: email, password }),
      await post('login/code', { contact: email }),
      await post('signup/verify', {
        challengeId,
        code: delivery.codeFor(challengeId),
      }),
    ]) {
      expect(response.statusCode).toBe(503);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toContain(
        'private Firebase credential details',
      );
    }
    expect(
      await database.selectFrom('auth_accounts').selectAll().execute(),
    ).toHaveLength(0);
    expect(
      await database
        .selectFrom('auth_challenges')
        .select('status')
        .where('id', '=', challengeId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'ready' });
    expect(delivery.messages).toHaveLength(1);
  });
});

describe('authentication HTTP and persistence', () => {
  it.each([
    { contact: email, method: 'password', selectedPassword: password },
    { contact: phone, method: 'password', selectedPassword: password },
    { contact: email, method: 'code', selectedPassword: undefined },
    { contact: phone, method: 'code', selectedPassword: undefined },
  ])(
    'activates $contact.kind signup using $method with one empty NGN wallet',
    async ({ contact, selectedPassword }) => {
      const session = await signup(contact, selectedPassword);
      const wallets = await database
        .selectFrom('wallets')
        .selectAll()
        .where('owner_id', '=', session.account.id)
        .execute();
      expect(wallets).toHaveLength(1);
      expect(wallets[0]).toMatchObject({
        owner_id: session.account.id,
        currency: 'NGN',
        wallet_status: 'active',
      });
      const wallet = await new WalletDataSource(database).readWallet(
        wallets[0]!.id,
      );
      expect(wallet).toMatchObject({
        available_debits: '0',
        available_credits: '0',
        reserved_debits: '0',
        reserved_credits: '0',
      });
      expect(
        await database.selectFrom('ledger_accounts').selectAll().execute(),
      ).toHaveLength(initialLedgerAccountCount + 2);

      advance(60);
      const login = await post('login/code', { contact });
      expect(login.statusCode).toBe(202);
      const challengeId = login.json().challengeId as string;
      expect(
        (
          await post('login/code/verify', {
            challengeId,
            code: delivery.codeFor(challengeId),
          })
        ).statusCode,
      ).toBe(200);
      expect(
        await database
          .selectFrom('wallets')
          .selectAll()
          .where('owner_id', '=', session.account.id)
          .execute(),
      ).toEqual(wallets);
    },
  );
  it('preserves leading-zero codes and password whitespace through DTO transformation', async () => {
    vi.spyOn(NodeAuthenticationSecrets.prototype, 'code').mockReturnValueOnce(
      '012345',
    );
    const exactPassword = '  a longer private passphrase  ';
    const challenge = await post('signup', {
      contact: email,
      password: exactPassword,
    });
    expect(challenge.statusCode).toBe(202);
    const verified = await post('signup/verify', {
      challengeId: challenge.json().challengeId,
      code: '012345',
    });
    expect(verified.statusCode).toBe(201);
    expect(
      (
        await post('login/password', {
          contact: email,
          password: exactPassword.trim(),
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await post('login/password', {
          contact: email,
          password: exactPassword,
        })
      ).statusCode,
    ).toBe(200);
  });
  it('reports the actual remaining code lifetime after delivery delay', async () => {
    vi.spyOn(delivery, 'send').mockImplementationOnce(async (message) => {
      delivery.messages.push(message);
      advance(30);
    });
    const response = await post('signup', { contact: email });
    expect(response.statusCode).toBe(202);
    expect(response.json().expiresInSeconds).toBe(270);
    expect(response.json().expiresAt).toBe('2030-01-01T00:05:00.000Z');
  });
  it.each([email, phone])(
    'verifies $kind signup, supports password login, and revokes only the logged-out session',
    async (contact) => {
      const session = await signup(contact, password);
      expect(session.account.contact).toEqual(contact);
      const identity = await me(session.accessToken);
      expect(identity.statusCode).toBe(200);
      expect(identity.headers['cache-control']).toBe('no-store');
      expect(identity.json()).toEqual(session.account);
      const login = await post('login/password', { contact, password });
      expect(login.statusCode).toBe(200);
      expect(login.json().accessToken).not.toBe(session.accessToken);
      const stored = await database
        .selectFrom('auth_accounts')
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(stored.password_hash).toMatch(/^\$argon2id\$/);
      expect(
        JSON.stringify(
          await database.selectFrom('auth_sessions').selectAll().execute(),
        ),
      ).not.toContain(session.accessToken);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const logout = await application.inject({
          method: 'POST',
          url: '/v1/auth/logout',
          headers: { authorization: `Bearer ${session.accessToken}` },
        });
        expect(logout.statusCode).toBe(204);
      }
      expect((await me(session.accessToken)).statusCode).toBe(401);
      expect((await me(login.json().accessToken)).statusCode).toBe(200);
    },
  );
  it.each([email, phone])(
    'supports passwordless $kind signup and subsequent one-time-code login',
    async (contact) => {
      await signup(contact);
      expect(
        (await post('login/password', { contact, password })).statusCode,
      ).toBe(401);
      advance(60);
      const request = await post('login/code', { contact });
      expect(request.statusCode).toBe(202);
      expect(request.json()).not.toHaveProperty('code');
      const challengeId = request.json().challengeId as string;
      const response = await post('login/code/verify', {
        challengeId,
        code: delivery.codeFor(challengeId),
      });
      expect(response.statusCode).toBe(200);
      expect((await me(response.json().accessToken)).statusCode).toBe(200);
    },
  );
  it('does not create an account or wallet or permit password login before contact verification', async () => {
    const response = await post('signup', { contact: email, password });
    expect(response.statusCode).toBe(202);
    expect(
      await database.selectFrom('auth_accounts').selectAll().execute(),
    ).toEqual([]);
    expect(
      await database.selectFrom('wallets').selectAll().execute(),
    ).toHaveLength(initialWalletCount);
    expect(
      (await post('login/password', { contact: email, password })).statusCode,
    ).toBe(401);
  });
  it('binds codes to their purpose and prevents replay', async () => {
    const requested = await post('signup', { contact: email });
    const challengeId = requested.json().challengeId as string;
    const body = { challengeId, code: delivery.codeFor(challengeId) };
    expect((await post('login/code/verify', body)).statusCode).toBe(401);
    expect((await post('signup/verify', body)).statusCode).toBe(201);
    expect((await post('signup/verify', body)).statusCode).toBe(401);
  });
  it('allows only one concurrent redemption and commits one account, wallet and session', async () => {
    const request = await post('signup', { contact: email });
    const challengeId = request.json().challengeId as string;
    const body = { challengeId, code: delivery.codeFor(challengeId) };
    const results = await Promise.all([
      post('signup/verify', body),
      post('signup/verify', body),
    ]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([
      201, 401,
    ]);
    expect(
      await database.selectFrom('auth_accounts').selectAll().execute(),
    ).toHaveLength(1);
    expect(
      await database.selectFrom('wallets').selectAll().execute(),
    ).toHaveLength(initialWalletCount + 1);
    expect(
      await database.selectFrom('ledger_accounts').selectAll().execute(),
    ).toHaveLength(initialLedgerAccountCount + 2);
    expect(
      await database.selectFrom('auth_sessions').selectAll().execute(),
    ).toHaveLength(1);
  });
  it('persists failed guesses, exhausts the code after five, and rejects even a later correct code', async () => {
    const request = await post('signup', { contact: email });
    const challengeId = request.json().challengeId as string;
    const correct = delivery.codeFor(challengeId);
    const incorrect = correct === '000000' ? '111111' : '000000';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        (await post('signup/verify', { challengeId, code: incorrect }))
          .statusCode,
      ).toBe(401);
    }
    expect(
      (await post('signup/verify', { challengeId, code: correct })).statusCode,
    ).toBe(401);
    expect(
      (
        await database
          .selectFrom('auth_challenges')
          .selectAll()
          .executeTakeFirstOrThrow()
      ).attempts,
    ).toBe(5);
  });
  it('expires codes at five minutes and sessions at their absolute deadline', async () => {
    const session = await signup(phone);
    const requested = await post('signup', { contact: email });
    const challengeId = requested.json().challengeId as string;
    advance(300);
    expect(
      (
        await post('signup/verify', {
          challengeId,
          code: delivery.codeFor(challengeId),
        })
      ).statusCode,
    ).toBe(401);
    advance(86400 - 300);
    expect((await me(session.accessToken)).statusCode).toBe(401);
  });
  it('enforces resend cooldown and invalidates the earlier code when replaced', async () => {
    const first = await post('signup', { contact: email });
    const earlierId = first.json().challengeId as string;
    const blocked = await post('signup', {
      contact: { kind: 'email', value: ' ALICE@EXAMPLE.COM ' },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBe('60');
    advance(60);
    const next = await post('signup', { contact: email });
    expect(next.statusCode).toBe(202);
    expect(
      (
        await post('signup/verify', {
          challengeId: earlierId,
          code: delivery.codeFor(earlierId),
        })
      ).statusCode,
    ).toBe(401);
    const latestId = next.json().challengeId as string;
    expect(
      (
        await post('signup/verify', {
          challengeId: latestId,
          code: delivery.codeFor(latestId),
        })
      ).statusCode,
    ).toBe(201);
  });
  it('never overwrites an existing account password through a repeated signup', async () => {
    await signup(email, password);
    advance(60);
    const request = await post('signup', {
      contact: email,
      password: 'a completely different passphrase',
    });
    expect(request.statusCode).toBe(202);
    const challengeId = request.json().challengeId as string;
    expect(
      (
        await post('signup/verify', {
          challengeId,
          code: delivery.codeFor(challengeId),
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await post('login/password', { contact: email, password })).statusCode,
    ).toBe(200);
    expect(
      await database.selectFrom('auth_accounts').selectAll().execute(),
    ).toHaveLength(1);
  });
  it('returns a generic login-code request for an unknown contact without implicitly registering it', async () => {
    const request = await post('login/code', { contact: email });
    expect(request.statusCode).toBe(202);
    const challengeId = request.json().challengeId as string;
    expect(
      (
        await post('login/code/verify', {
          challengeId,
          code: delivery.codeFor(challengeId),
        })
      ).statusCode,
    ).toBe(401);
    expect(
      await database.selectFrom('auth_accounts').selectAll().execute(),
    ).toEqual([]);
  });
  it('invalidates delivery failures and returns no usable code or session', async () => {
    delivery.fail = true;
    const response = await post('signup', { contact: email, password });
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('DELIVERY_UNAVAILABLE');
    expect(response.json()).not.toHaveProperty('challengeId');
    const challenge = await database
      .selectFrom('auth_challenges')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(challenge.status).toBe('invalidated');
    expect(challenge.password_hash).toBeNull();
  });
  it('rolls back the account, wallet and code consumption when session persistence fails', async () => {
    const request = await post('signup', { contact: email });
    const challengeId = request.json().challengeId as string;
    const body = { challengeId, code: delivery.codeFor(challengeId) };
    const failure = vi
      .spyOn(AuthenticationRepositoryImpl.prototype, 'createSession')
      .mockRejectedValueOnce(new Error('simulated storage failure'));
    expect((await post('signup/verify', body)).statusCode).toBe(503);
    failure.mockRestore();
    expect(
      await database.selectFrom('auth_accounts').selectAll().execute(),
    ).toHaveLength(0);
    expect(
      await database.selectFrom('wallets').selectAll().execute(),
    ).toHaveLength(initialWalletCount);
    expect(
      await database.selectFrom('ledger_accounts').selectAll().execute(),
    ).toHaveLength(initialLedgerAccountCount);
    expect(
      await database.selectFrom('ledger_balances').selectAll().execute(),
    ).toHaveLength(initialLedgerBalanceCount);
    expect(
      (
        await database
          .selectFrom('auth_challenges')
          .selectAll()
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('ready');
    expect((await post('signup/verify', body)).statusCode).toBe(201);
    expect(
      await database.selectFrom('wallets').selectAll().execute(),
    ).toHaveLength(initialWalletCount + 1);
  });
  it('rolls back partial wallet provisioning and permits the same signup proof to be retried', async () => {
    const request = await post('signup', { contact: email });
    expect(request.statusCode).toBe(202);
    const challengeId = request.json().challengeId as string;
    const body = { challengeId, code: delivery.codeFor(challengeId) };
    // Provisioning has inserted the wallet and ledger accounts before reading the resulting balance.
    const failure = vi
      .spyOn(WalletDataSource.prototype, 'readWallet')
      .mockRejectedValueOnce(new Error('simulated wallet storage failure'));
    const response = await post('signup/verify', body);
    failure.mockRestore();
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('AUTHENTICATION_UNAVAILABLE');
    expect(
      await database.selectFrom('auth_accounts').selectAll().execute(),
    ).toEqual([]);
    expect(
      await database.selectFrom('auth_sessions').selectAll().execute(),
    ).toEqual([]);
    expect(
      await database.selectFrom('wallets').selectAll().execute(),
    ).toHaveLength(initialWalletCount);
    expect(
      await database.selectFrom('ledger_accounts').selectAll().execute(),
    ).toHaveLength(initialLedgerAccountCount);
    expect(
      await database.selectFrom('ledger_balances').selectAll().execute(),
    ).toHaveLength(initialLedgerBalanceCount);
    expect(
      await database
        .selectFrom('auth_challenges')
        .select('status')
        .where('id', '=', challengeId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'ready' });
    expect((await post('signup/verify', body)).statusCode).toBe(201);
    expect(
      await database.selectFrom('wallets').selectAll().execute(),
    ).toHaveLength(initialWalletCount + 1);
  });
  it('rolls back challenge replacement inside nested repository transactions', async () => {
    const request = await post('signup', { contact: email });
    const challengeId = request.json().challengeId as string;
    const original = await database
      .selectFrom('auth_challenges')
      .selectAll()
      .where('id', '=', challengeId)
      .executeTakeFirstOrThrow();
    const repository = new AuthenticationRepositoryImpl(database);

    await expect(
      repository.transaction(async (outer) => {
        await outer.transaction(async (nested) => {
          const challenge = await nested.lockChallenge(challengeId);
          if (!challenge) {
            throw new Error('Expected the existing challenge.');
          }
          await nested.storeChallenge({
            ...challenge,
            id: randomUUID(),
            status: 'pending',
          });
          expect((await nested.lockChallenge(challengeId))?.status).toBe(
            'invalidated',
          );
        });
        throw new Error('simulated outer rollback');
      }),
    ).rejects.toThrow('simulated outer rollback');

    expect(
      await database.selectFrom('auth_challenges').selectAll().execute(),
    ).toEqual([original]);
    expect(
      (
        await post('signup/verify', {
          challengeId,
          code: delivery.codeFor(challengeId),
        })
      ).statusCode,
    ).toBe(201);
  });
  it('limits concurrent code requests across clients to one contact delivery per cooldown', async () => {
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        application.inject({
          method: 'POST',
          url: '/v1/auth/signup',
          payload: { contact: email },
          remoteAddress: `192.0.2.${index + 1}`,
        }),
      ),
    );
    expect(
      responses.filter((response) => response.statusCode === 202),
    ).toHaveLength(1);
    expect(
      responses.filter((response) => response.statusCode === 429),
    ).toHaveLength(11);
    expect(delivery.messages).toHaveLength(1);
  });
  it('throttles password guessing identically for registered and unknown contacts', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(
        (
          await post('login/password', {
            contact: email,
            password: 'incorrect',
          })
        ).statusCode,
      ).toBe(401);
    }
    const blocked = await post('login/password', {
      contact: email,
      password: 'incorrect',
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBe('900');
  });
  it('rejects a disabled account even when its stored session has not expired', async () => {
    const session = await signup(email);
    await database
      .updateTable('auth_accounts')
      .set({ disabled_at: clock.now() })
      .where('id', '=', session.account.id)
      .execute();
    expect((await me(session.accessToken)).statusCode).toBe(401);
  });
  it('rejects malformed bodies, extra authorization fields, and missing bearer tokens', async () => {
    expect(
      (await post('signup', { contact: email, password: 'short' })).statusCode,
    ).toBe(400);
    expect(
      (await post('signup', { contact: email, verified: true })).statusCode,
    ).toBe(400);
    expect(
      (
        await post('signup/verify', {
          challengeId: 'not-a-uuid',
          code: '000000',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await application.inject({ method: 'GET', url: '/v1/auth/me' }))
        .statusCode,
    ).toBe(401);
    expect((await me('malformed')).statusCode).toBe(401);
  });
});

/** Request a fresh reset after the shared contact cooldown and capture only the recipient's test code. */
async function requestReset(contact: Contact) {
  advance(60);
  const request = await post('password/forgot', { contact });
  expect(request.statusCode).toBe(202);
  expect(request.headers['cache-control']).toBe('no-store');
  expect(request.json()).toEqual({
    challengeId: expect.any(String),
    expiresAt: expect.any(String),
    expiresInSeconds: 300,
    resendAfterSeconds: 60,
  });
  const challengeId = request.json().challengeId as string;
  return { challengeId, code: delivery.codeFor(challengeId) };
}
const newPassword = '  my replacement private passphrase  ';

describe('one-time-code password recovery', () => {
  it.each([email, phone])(
    'resets a $kind password and revokes only that account access',
    async (contact) => {
      const owner = await signup(contact, password);
      const otherContact = contact.kind === 'email' ? phone : email;
      const other = await signup(otherContact, password);
      const secondSession = await post('login/password', { contact, password });
      const proof = await requestReset(contact);
      const reset = await post('password/reset', { ...proof, newPassword });
      expect(reset.statusCode).toBe(204);
      expect(reset.body).toBe('');
      expect(reset.headers['cache-control']).toBe('no-store');
      expect((await me(owner.accessToken)).statusCode).toBe(401);
      expect((await me(secondSession.json().accessToken)).statusCode).toBe(401);
      expect((await me(other.accessToken)).statusCode).toBe(200);
      expect(
        (await post('login/password', { contact, password })).statusCode,
      ).toBe(401);
      expect(
        (
          await post('login/password', {
            contact,
            password: newPassword.trim(),
          })
        ).statusCode,
      ).toBe(401);
      const login = await post('login/password', {
        contact,
        password: newPassword,
      });
      expect(login.statusCode).toBe(200);
      expect(login.json().account.id).toBe(owner.account.id);
      const stored = await database
        .selectFrom('auth_accounts')
        .selectAll()
        .where('id', '=', owner.account.id)
        .executeTakeFirstOrThrow();
      expect(stored.password_hash).toMatch(/^\$argon2id\$/);
      expect(stored.password_hash).not.toContain(newPassword);
      expect(stored.credential_version).toBe(1);
      expect(
        (await post('password/reset', { ...proof, newPassword: password }))
          .statusCode,
      ).toBe(401);
      expect(
        (await post('login/password', { contact, password: newPassword }))
          .statusCode,
      ).toBe(200);
    },
  );
  it('allows a verified code-only account to establish its first password', async () => {
    const owner = await signup(email);
    vi.spyOn(NodeAuthenticationSecrets.prototype, 'code').mockReturnValueOnce(
      '012345',
    );
    const proof = await requestReset(email);
    expect(proof.code).toBe('012345');
    expect(
      (await post('password/reset', { ...proof, newPassword })).statusCode,
    ).toBe(204);
    const login = await post('login/password', {
      contact: email,
      password: newPassword,
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().account.id).toBe(owner.account.id);
  });
  it('keeps request contracts identical for known, unknown, and disabled contacts', async () => {
    const owner = await signup(email, password);
    const known = await requestReset(email);
    const unknown = await requestReset(phone);
    await database
      .updateTable('auth_accounts')
      .set({ disabled_at: clock.now() })
      .where('id', '=', owner.account.id)
      .execute();
    const disabled = await requestReset(email);
    for (const proof of [known, unknown, disabled]) {
      const response = await post('password/reset', { ...proof, newPassword });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('INVALID_CREDENTIALS');
    }
    expect(
      await database.selectFrom('auth_accounts').selectAll().execute(),
    ).toHaveLength(1);
    expect(
      (
        await database
          .selectFrom('auth_accounts')
          .selectAll()
          .executeTakeFirstOrThrow()
      ).credential_version,
    ).toBe(0);
  });
  it('cannot apply a reset issued before the contact was registered', async () => {
    const proof = await requestReset(email);
    advance(60);
    await signup(email, password);
    expect(
      (await post('password/reset', { ...proof, newPassword })).statusCode,
    ).toBe(401);
    expect(
      (await post('login/password', { contact: email, password })).statusCode,
    ).toBe(200);
  });
  it('rejects cross-purpose codes without consuming the correctly bound operation', async () => {
    const signupRequest = await post('signup', { contact: email, password });
    const signupId = signupRequest.json().challengeId as string;
    const signupProof = {
      challengeId: signupId,
      code: delivery.codeFor(signupId),
    };
    expect(
      (await post('password/reset', { ...signupProof, newPassword }))
        .statusCode,
    ).toBe(401);
    expect((await post('signup/verify', signupProof)).statusCode).toBe(201);
    advance(60);
    const loginRequest = await post('login/code', { contact: email });
    const loginId = loginRequest.json().challengeId as string;
    const loginProof = {
      challengeId: loginId,
      code: delivery.codeFor(loginId),
    };
    expect(
      (await post('password/reset', { ...loginProof, newPassword })).statusCode,
    ).toBe(401);
    expect((await post('login/code/verify', loginProof)).statusCode).toBe(200);
    const resetProof = await requestReset(email);
    expect((await post('login/code/verify', resetProof)).statusCode).toBe(401);
    expect((await post('signup/verify', resetProof)).statusCode).toBe(401);
    expect(
      (await post('password/reset', { ...resetProof, newPassword })).statusCode,
    ).toBe(204);
  });
  it('expires reset proof at five minutes and never changes the password or sessions', async () => {
    const owner = await signup(email, password);
    const proof = await requestReset(email);
    advance(300);
    expect(
      (await post('password/reset', { ...proof, newPassword })).statusCode,
    ).toBe(401);
    expect((await me(owner.accessToken)).statusCode).toBe(200);
    expect(
      (await post('login/password', { contact: email, password })).statusCode,
    ).toBe(200);
  });
  it('rechecks expiry if password hashing crosses the code deadline', async () => {
    const owner = await signup(email, password);
    const proof = await requestReset(email);
    const original = ArgonPasswordHasher.prototype.hash;
    vi.spyOn(ArgonPasswordHasher.prototype, 'hash').mockImplementationOnce(
      async function (this: ArgonPasswordHasher, candidate) {
        const hashed = await original.call(this, candidate);
        advance(300);
        return hashed;
      },
    );
    expect(
      (await post('password/reset', { ...proof, newPassword })).statusCode,
    ).toBe(401);
    expect((await me(owner.accessToken)).statusCode).toBe(200);
    expect(
      (await post('login/password', { contact: email, password })).statusCode,
    ).toBe(200);
  });
  it('commits five wrong guesses without hashing a password or revoking access', async () => {
    const owner = await signup(email, password);
    const proof = await requestReset(email);
    const hashing = vi.spyOn(ArgonPasswordHasher.prototype, 'hash');
    const wrongCode = proof.code === '000000' ? '111111' : '000000';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        (
          await post('password/reset', {
            ...proof,
            code: wrongCode,
            newPassword,
          })
        ).statusCode,
      ).toBe(401);
    }
    expect(
      (await post('password/reset', { ...proof, newPassword })).statusCode,
    ).toBe(401);
    expect(hashing).not.toHaveBeenCalled();
    expect(
      (
        await database
          .selectFrom('auth_challenges')
          .selectAll()
          .where('id', '=', proof.challengeId)
          .executeTakeFirstOrThrow()
      ).attempts,
    ).toBe(5);
    expect((await me(owner.accessToken)).statusCode).toBe(200);
  });
  it('shares resend budgets across purposes and supersedes only the earlier reset', async () => {
    await signup(email, password);
    const first = await requestReset(email);
    const blocked = await post('password/forgot', {
      contact: { kind: 'email', value: ' ALICE@EXAMPLE.COM ' },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBe('60');
    const blockedLogin = await post('login/code', { contact: email });
    expect(blockedLogin.statusCode).toBe(429);
    const second = await requestReset(email);
    expect(
      (await post('password/reset', { ...first, newPassword })).statusCode,
    ).toBe(401);
    expect(
      (await post('password/reset', { ...second, newPassword })).statusCode,
    ).toBe(204);
  });
  it('invalidates failed deliveries without changing credentials or issuing a reset reference', async () => {
    const owner = await signup(email, password);
    advance(60);
    delivery.fail = true;
    const response = await post('password/forgot', { contact: email });
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('DELIVERY_UNAVAILABLE');
    expect(response.json()).not.toHaveProperty('challengeId');
    const challenge = await database
      .selectFrom('auth_challenges')
      .selectAll()
      .where('purpose', '=', 'password-reset')
      .executeTakeFirstOrThrow();
    expect(challenge.status).toBe('invalidated');
    expect((await me(owner.accessToken)).statusCode).toBe(200);
  });
  it('allows one concurrent redemption and one credential version change', async () => {
    await signup(email, password);
    const proof = await requestReset(email);
    const responses = await Promise.all([
      post('password/reset', { ...proof, newPassword }),
      post('password/reset', {
        ...proof,
        newPassword: 'another replacement passphrase',
      }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      204, 401,
    ]);
    expect(
      (
        await database
          .selectFrom('auth_accounts')
          .selectAll()
          .executeTakeFirstOrThrow()
      ).credential_version,
    ).toBe(1);
    expect(
      await database
        .selectFrom('auth_sessions')
        .selectAll()
        .where('revoked_at', 'is', null)
        .execute(),
    ).toHaveLength(0);
  });
  it('rolls back password, version, consumption, and session revocation on storage failure', async () => {
    const owner = await signup(email, password);
    const proof = await requestReset(email);
    const original = AuthenticationRepositoryImpl.prototype.replacePassword;
    const failure = vi
      .spyOn(AuthenticationRepositoryImpl.prototype, 'replacePassword')
      .mockImplementationOnce(async function (
        this: AuthenticationRepositoryImpl,
        account,
        hash,
        now,
      ) {
        await original.call(this, account, hash, now);
        throw new Error('simulated failure after recovery writes');
      });
    const failed = await post('password/reset', { ...proof, newPassword });
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain(newPassword);
    failure.mockRestore();
    expect(
      (
        await database
          .selectFrom('auth_challenges')
          .selectAll()
          .where('id', '=', proof.challengeId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('ready');
    expect((await me(owner.accessToken)).statusCode).toBe(200);
    expect(
      (await post('login/password', { contact: email, password })).statusCode,
    ).toBe(200);
    expect(
      (await post('password/reset', { ...proof, newPassword })).statusCode,
    ).toBe(204);
  });
  it('rejects an earlier login code after recovery but accepts newly requested code login', async () => {
    await signup(email, password);
    advance(60);
    const request = await post('login/code', { contact: email });
    const challengeId = request.json().challengeId as string;
    const proof = { challengeId, code: delivery.codeFor(challengeId) };
    const reset = await requestReset(email);
    expect(
      (await post('password/reset', { ...reset, newPassword })).statusCode,
    ).toBe(204);
    expect((await post('login/code/verify', proof)).statusCode).toBe(401);
    advance(60);
    const fresh = await post('login/code', { contact: email });
    const freshId = fresh.json().challengeId as string;
    expect(
      (
        await post('login/code/verify', {
          challengeId: freshId,
          code: delivery.codeFor(freshId),
        })
      ).statusCode,
    ).toBe(200);
  });
  it('rejects a password login whose verification began before recovery committed', async () => {
    await signup(email, password);
    const proof = await requestReset(email);
    const reached = asyncSignal();
    const release = asyncSignal();
    const original = ArgonPasswordHasher.prototype.verify;
    vi.spyOn(ArgonPasswordHasher.prototype, 'verify').mockImplementationOnce(
      async function (this: ArgonPasswordHasher, candidate, hash) {
        const valid = await original.call(this, candidate, hash);
        reached.resolve();
        await release.promise;
        return valid;
      },
    );
    const pendingLogin = post('login/password', {
      contact: email,
      password,
    }).then((response) => response);
    try {
      await reached.promise;
      expect(
        (await post('password/reset', { ...proof, newPassword })).statusCode,
      ).toBe(204);
    } finally {
      release.resolve();
    }
    expect((await pendingLogin).statusCode).toBe(401);
    expect(
      await database
        .selectFrom('auth_sessions')
        .selectAll()
        .where('revoked_at', 'is', null)
        .execute(),
    ).toHaveLength(0);
  });
});

/** Validate rotating credentials through real HTTP and transactional PostgreSQL, including committed replay rejection. */
describe('rotating refresh sessions', () => {
  it('issues separate short-lived access and one-use refresh credentials without persisting raw secrets', async () => {
    const session = await signup(email, password);
    expect(session).toMatchObject({
      expiresInSeconds: 900,
      refreshExpiresInSeconds: 2592000,
      tokenType: 'Bearer',
    });
    expect(session.sessionId).toMatch(/^[a-f0-9-]{36}$/);
    expect(session.refreshToken).not.toBe(session.accessToken);
    expect((await me(session.refreshToken)).statusCode).toBe(401);
    expect(
      (await post('refresh', { refreshToken: session.accessToken })).statusCode,
    ).toBe(401);
    const stored = await database
      .selectFrom('auth_refresh_tokens')
      .selectAll()
      .execute();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.session_id).toBe(session.sessionId);
    expect(JSON.stringify(stored)).not.toContain(session.refreshToken);
    expect(JSON.stringify(stored)).not.toContain(session.accessToken);
  });

  it('renews after access expiry without changing family identity or primary-authentication freshness', async () => {
    const session = await signup(email, password);
    const original = await database
      .selectFrom('auth_sessions')
      .selectAll()
      .where('id', '=', session.sessionId)
      .executeTakeFirstOrThrow();
    advance(901);
    expect((await me(session.accessToken)).statusCode).toBe(401);
    for (const key of Object.values(remoteConfigFlagKeys)) {
      remoteConfig.setFlag(key, false);
    }
    const response = await post('refresh', {
      refreshToken: session.refreshToken,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const renewed = response.json<AuthenticationResult>();
    expect(renewed.sessionId).toBe(session.sessionId);
    expect(renewed.account).toEqual(session.account);
    expect(renewed.accessToken).not.toBe(session.accessToken);
    expect(renewed.refreshToken).not.toBe(session.refreshToken);
    expect(renewed.refreshExpiresInSeconds).toBe(2592000 - 901);
    expect((await me(renewed.accessToken)).statusCode).toBe(200);
    const updated = await database
      .selectFrom('auth_sessions')
      .selectAll()
      .where('id', '=', session.sessionId)
      .executeTakeFirstOrThrow();
    expect(updated.primary_authenticated_at).toEqual(
      original.primary_authenticated_at,
    );
    expect(updated.refresh_expires_at).toEqual(original.refresh_expires_at);
    expect((await me(session.accessToken)).statusCode).toBe(401);
  });

  it('commits family revocation on replay, invalidating the successor credentials too', async () => {
    const session = await signup(email);
    const first = await post('refresh', { refreshToken: session.refreshToken });
    expect(first.statusCode).toBe(200);
    const next = first.json<AuthenticationResult>();
    expect(
      (await post('refresh', { refreshToken: session.refreshToken }))
        .statusCode,
    ).toBe(401);
    expect((await me(next.accessToken)).statusCode).toBe(401);
    expect(
      (await post('refresh', { refreshToken: next.refreshToken })).statusCode,
    ).toBe(401);
    const stored = await database
      .selectFrom('auth_sessions')
      .select('revoked_at')
      .where('id', '=', session.sessionId)
      .executeTakeFirstOrThrow();
    expect(stored.revoked_at).not.toBeNull();
  });

  it('serializes duplicate refresh proofs and revokes the single winning generation on detected reuse', async () => {
    const session = await signup(email);
    const responses = await Promise.all([
      post('refresh', { refreshToken: session.refreshToken }),
      post('refresh', { refreshToken: session.refreshToken }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 401,
    ]);
    const winner = responses
      .find((response) => response.statusCode === 200)!
      .json<AuthenticationResult>();
    expect((await me(winner.accessToken)).statusCode).toBe(401);
    expect(
      await database.selectFrom('auth_refresh_tokens').selectAll().execute(),
    ).toHaveLength(2);
  });

  it('rolls back proof consumption and both credential changes on a failed rotation commit', async () => {
    const session = await signup(email);
    const rotate = AuthenticationRepositoryImpl.prototype.rotateSession;
    vi.spyOn(
      AuthenticationRepositoryImpl.prototype,
      'rotateSession',
    ).mockImplementationOnce(async function (
      this: AuthenticationRepositoryImpl,
      input,
    ) {
      await rotate.call(this, input);
      throw new Error('private refresh commit fixture');
    });
    const failed = await post('refresh', {
      refreshToken: session.refreshToken,
    });
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain('private refresh');
    expect((await me(session.accessToken)).statusCode).toBe(200);
    const records = await database
      .selectFrom('auth_refresh_tokens')
      .selectAll()
      .execute();
    expect(records).toHaveLength(1);
    expect(records[0]?.consumed_at).toBeNull();
    expect(
      (await post('refresh', { refreshToken: session.refreshToken }))
        .statusCode,
    ).toBe(200);
  });

  it('never extends the absolute refresh deadline or issues access beyond it', async () => {
    const session = await signup(email);
    advance(2592000 - 10);
    const renewed = await post('refresh', {
      refreshToken: session.refreshToken,
    });
    expect(renewed.statusCode).toBe(200);
    expect(renewed.json()).toMatchObject({
      expiresInSeconds: 10,
      refreshExpiresInSeconds: 10,
    });
    advance(10);
    expect(
      (await post('refresh', { refreshToken: renewed.json().refreshToken }))
        .statusCode,
    ).toBe(401);
    expect((await me(renewed.json().accessToken)).statusCode).toBe(401);
  });

  it('logs out a rotated family using its earlier access token while preserving a separate login', async () => {
    const session = await signup(email, password);
    const independent = await post('login/password', {
      contact: email,
      password,
    });
    const next = await post('refresh', { refreshToken: session.refreshToken });
    const logout = await application.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: `Bearer ${session.accessToken}` },
      payload: {},
    });
    expect(logout.statusCode).toBe(204);
    expect((await me(next.json().accessToken)).statusCode).toBe(401);
    expect(
      (await post('refresh', { refreshToken: next.json().refreshToken }))
        .statusCode,
    ).toBe(401);
    expect((await me(independent.json().accessToken)).statusCode).toBe(200);
  });

  it.each(['disabled', 'password-reset'] as const)(
    'cannot renew after %s',
    async (change) => {
      const session = await signup(email, password);
      if (change === 'disabled') {
        await database
          .updateTable('auth_accounts')
          .set({ disabled_at: currentTime })
          .where('id', '=', session.account.id)
          .execute();
      }
      if (change === 'password-reset') {
        advance(61);
        const request = await post('password/forgot', { contact: email });
        const challengeId = request.json().challengeId as string;
        expect(
          (
            await post('password/reset', {
              challengeId,
              code: delivery.codeFor(challengeId),
              newPassword: 'a replacement private password',
            })
          ).statusCode,
        ).toBe(204);
      }
      expect(
        (await post('refresh', { refreshToken: session.refreshToken }))
          .statusCode,
      ).toBe(401);
      expect((await me(session.accessToken)).statusCode).toBe(401);
    },
  );
});
