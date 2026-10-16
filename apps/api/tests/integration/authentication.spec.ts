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
import { createDatabase } from '@axiapay/payments-runtime/infrastructure/database/create-database';
import { NodeAuthenticationSecrets } from '../../src/modules/authentication/security/node-authentication-secrets.js';
import { AuthenticationModule } from '../../src/modules/authentication/authentication.module.js';
import { DatabaseConnection } from '@axiapay/payments-runtime/infrastructure/database/database.module';
import { RequestValidationModule } from '../../src/bootstrap/request-validation.module.js';
import { AUTHENTICATION } from '../../src/modules/authentication/authentication.tokens.js';
import { PostgresAuthenticationRepository } from '../../src/modules/authentication/repositories/postgres-authentication.repository.js';
import type { AuthenticationCodeDelivery } from '../../src/modules/authentication/ports/authentication.ports.js';
import type { AuthenticationDatabase } from '../../src/modules/authentication/repositories/authentication-database.js';
import type { AuthenticationResult } from '../../src/modules/authentication/services/authentication-session.js';
import type { Contact } from '../../src/modules/authentication/domain/authentication-models.js';

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
let database: Kysely<AuthenticationDatabase>;
let application: NestFastifyApplication;
let currentTime = new Date();
const clock = {
  /** Expose test time without changing global timers or database clocks. */ now: () =>
    new Date(currentTime),
};
const delivery = new CapturedCodeDelivery();
const email: Contact = { kind: 'email', value: 'alice@example.com' };
const phone: Contact = { kind: 'phone', value: '+2348012345678' };
const password = 'a longer private passphrase';

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').start();
  database = createDatabase(
    container.getConnectionUri(),
  ).withTables<AuthenticationDatabase>();
  const migrationPath = new URL(
    '../../migrations/202610130000-authentication.js',
    import.meta.url,
  ).href;
  const migrator = new Migrator({
    db: database,
    provider: {
      /** Load only this feature's migration so unrelated work is not required. */ getMigrations:
        async () => ({
          authentication: await import(migrationPath),
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
    .overrideProvider(DatabaseConnection)
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

describe('authentication HTTP and persistence', () => {
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
  it('does not create an account or permit password login before contact verification', async () => {
    const response = await post('signup', { contact: email, password });
    expect(response.statusCode).toBe(202);
    expect(
      await database.selectFrom('auth_accounts').selectAll().execute(),
    ).toEqual([]);
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
  it('allows only one concurrent redemption and commits one account and session', async () => {
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
  it('rolls back account creation and code consumption together when session persistence fails', async () => {
    const request = await post('signup', { contact: email });
    const challengeId = request.json().challengeId as string;
    const body = { challengeId, code: delivery.codeFor(challengeId) };
    const failure = vi
      .spyOn(PostgresAuthenticationRepository.prototype, 'createSession')
      .mockRejectedValueOnce(new Error('simulated storage failure'));
    expect((await post('signup/verify', body)).statusCode).toBe(503);
    failure.mockRestore();
    expect(
      await database.selectFrom('auth_accounts').selectAll().execute(),
    ).toHaveLength(0);
    expect(
      (
        await database
          .selectFrom('auth_challenges')
          .selectAll()
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('ready');
    expect((await post('signup/verify', body)).statusCode).toBe(201);
  });
  it('rolls back challenge replacement inside nested repository transactions', async () => {
    const request = await post('signup', { contact: email });
    const challengeId = request.json().challengeId as string;
    const original = await database
      .selectFrom('auth_challenges')
      .selectAll()
      .where('id', '=', challengeId)
      .executeTakeFirstOrThrow();
    const repository = new PostgresAuthenticationRepository(database);

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
    const original = PostgresAuthenticationRepository.prototype.replacePassword;
    const failure = vi
      .spyOn(PostgresAuthenticationRepository.prototype, 'replacePassword')
      .mockImplementationOnce(async function (
        this: PostgresAuthenticationRepository,
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
