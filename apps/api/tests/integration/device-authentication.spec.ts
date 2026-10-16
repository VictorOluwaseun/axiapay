import { SessionCacheInvalidationConnection } from '../../src/infrastructure/database/session-cache-invalidation.connection.js';
import { asyncSignal } from '../../../../packages/payments-runtime/tests/support/async-signal.js';
import { BadRequestException } from '@nestjs/common';
import { withValidatedInput } from '@axiapay/payments-runtime/shared/validation/input-validation';
import { DeviceIdentifierDto } from '../../src/modules/authentication/dtos/device-authentication.dto.js';
/** Exercise Android-compatible signatures through the real Nest module, PostgreSQL transactions, and opaque sessions. */
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
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
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { createDatabase } from '@axiapay/payments-runtime/infrastructure/database/create-database';
import { DatabaseConnection } from '@axiapay/payments-runtime/infrastructure/database/database.module';
import { RequestValidationModule } from '../../src/bootstrap/request-validation.module.js';
import { AuthenticationModule } from '../../src/modules/authentication/authentication.module.js';
import { AUTHENTICATION } from '../../src/modules/authentication/authentication.tokens.js';
import type { AuthenticationCodeDelivery } from '../../src/modules/authentication/ports/authentication.ports.js';
import type { AuthenticationDatabase } from '../../src/modules/authentication/repositories/authentication-database.js';
import type { AuthenticationResult } from '../../src/modules/authentication/services/authentication-session.js';
import type { Contact } from '../../src/modules/authentication/domain/authentication-models.js';
import { AuthenticationRepositoryImpl } from '../../src/modules/authentication/repositories/authentication.repository.impl.js';
import { PostgresDeviceAuthenticationRepository } from '../../src/modules/authentication/repositories/postgres-device-authentication.repository.js';
import { DeviceAuthenticationService } from '../../src/modules/authentication/services/device-authentication.service.js';

/** Client-visible challenge fields needed for signing, independent of database or server implementation details. */
interface Challenge {
  challengeId: string;
  credentialId: string;
  message: string;
  expiresAt: string;
}
let container: StartedPostgreSqlContainer;
let database: Kysely<AuthenticationDatabase>;
let application: NestFastifyApplication;
let currentTime = new Date('2030-01-01T00:00:00Z');
const codes = new Map<string, string>();
const password = 'a longer private passphrase';
const email: Contact = { kind: 'email', value: 'alice@example.com' };
const delivery: AuthenticationCodeDelivery = {
  /** Capture only the test recipient's code through the delivery port. */
  async send(message) {
    codes.set(message.challengeId, message.code);
  },
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').start();
  database = createDatabase(
    container.getConnectionUri(),
  ).withTables<AuthenticationDatabase>();
  const migrator = new Migrator({
    db: database,
    provider: {
      /** Device fixtures use real signup, including its atomic wallet provisioning. */
      async getMigrations() {
        return {
          authentication: await import(
            new URL(
              '../../migrations/202610130000-authentication.js',
              import.meta.url,
            ).href
          ),
          devices: await import(
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
          sessionInvalidations: await import(
            new URL(
              '../../migrations/202610160014-auth-session-cache-invalidation.js',
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
        };
      },
    },
  });
  const result = await migrator.migrateToLatest();
  if (result.error) {
    throw result.error;
  }
  const module = await Test.createTestingModule({
    imports: [RequestValidationModule, AuthenticationModule],
  })
    .overrideProvider(DatabaseConnection)
    .useValue({ database })
    .overrideProvider(SessionCacheInvalidationConnection)
    .useValue({ database })
    .overrideProvider(AUTHENTICATION.codeDelivery)
    .useValue(delivery)
    .overrideProvider(AUTHENTICATION.clock)
    .useValue({
      /** Advance application time deterministically for expiry and freshness cases. */
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
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await sql`truncate auth_accounts, auth_challenges, auth_rate_limits cascade`.execute(
    database,
  );
  currentTime = new Date('2030-01-01T00:00:00Z');
  codes.clear();
});
afterAll(async () => {
  await application?.close();
  await database?.destroy();
  await container?.stop();
});

/** Send JSON through actual DTO validation and optional bearer authorization. */
function post(route: string, payload: object, token?: string) {
  return application.inject({
    method: 'POST',
    url: `/v1/auth/${route}`,
    payload,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}
/** Activate an email or phone account through its delivered code, with optional password credentials. */
async function signup(
  contact: Contact = email,
  withPassword = false,
): Promise<AuthenticationResult> {
  const challenge = await post('signup', {
    contact,
    ...(withPassword ? { password } : {}),
  });
  expect(challenge.statusCode).toBe(202);
  const challengeId = challenge.json().challengeId as string;
  const result = await post('signup/verify', {
    challengeId,
    code: codes.get(challengeId),
  });
  expect(result.statusCode).toBe(201);
  return result.json();
}
/** Generate the same EC curve and SPKI representation expected from Android Keystore. */
function deviceKeys() {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKey: keys.privateKey,
    publicKey: keys.publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64url'),
  };
}
/** Sign decoded server bytes using Java's SHA256withECDSA-compatible ASN.1 DER representation. */
function proof(challenge: Challenge, keys: ReturnType<typeof deviceKeys>) {
  return {
    challengeId: challenge.challengeId,
    credentialId: challenge.credentialId,
    signature: sign('sha256', Buffer.from(challenge.message, 'base64url'), {
      key: keys.privateKey,
      dsaEncoding: 'der',
    }).toString('base64url'),
  };
}
/** Request enrollment without implicitly completing proof of possession. */
async function beginEnrollment(
  token: string,
  keys = deviceKeys(),
): Promise<{ challenge: Challenge; keys: ReturnType<typeof deviceKeys> }> {
  const result = await post(
    'devices/enrollment/challenge',
    { deviceName: 'My Android phone', publicKey: keys.publicKey },
    token,
  );
  expect(result.statusCode).toBe(200);
  return { challenge: result.json(), keys };
}
/** Register a device through the public opt-in and key-possession workflow. */
async function enroll(token: string, keys = deviceKeys()) {
  const pending = await beginEnrollment(token, keys);
  const result = await post(
    'devices/enrollment/verify',
    proof(pending.challenge, keys),
    token,
  );
  expect(result.statusCode).toBe(201);
  return { credentialId: pending.challenge.credentialId, keys };
}
/** Obtain a fresh server challenge for a registered or unknown opaque identifier. */
async function loginChallenge(credentialId: string): Promise<Challenge> {
  const result = await post('login/device/challenge', { credentialId });
  expect(result.statusCode).toBe(200);
  return result.json();
}
/** Resolve a returned session through the same guard used by other feature routes. */
function me(token: string) {
  return application.inject({
    method: 'GET',
    url: '/v1/auth/me',
    headers: { authorization: `Bearer ${token}` },
  });
}
/** Remove a key through the account-authorized device-management route. */
function revoke(token: string, credentialId: string) {
  return application.inject({
    method: 'DELETE',
    url: `/v1/auth/devices/${credentialId}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('device authentication', () => {
  it.each([
    [email, false],
    [email, true],
    [{ kind: 'phone', value: '+2348012345678' } as Contact, false],
    [{ kind: 'phone', value: '+2348012345678' } as Contact, true],
  ])(
    'enrolls and logs in a verified %j account (password=%s)',
    async (contact, withPassword) => {
      const session = await signup(contact, withPassword);
      const device = await enroll(session.accessToken);
      const challenge = await loginChallenge(device.credentialId);
      const result = await post(
        'login/device/verify',
        proof(challenge, device.keys),
      );
      expect(result.statusCode).toBe(200);
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.json()).toMatchObject({
        tokenType: 'Bearer',
        expiresInSeconds: 86400,
        account: session.account,
      });
      expect((await me(result.json().accessToken)).statusCode).toBe(200);
      const stored = await database
        .selectFrom('auth_sessions')
        .selectAll()
        .where('device_credential_id', '=', device.credentialId)
        .executeTakeFirstOrThrow();
      expect(stored.primary_authenticated_at).toBeNull();
      expect(stored.token_digest).not.toBe(result.json().accessToken);
      const list = await application.inject({
        method: 'GET',
        url: '/v1/auth/devices',
        headers: { authorization: `Bearer ${session.accessToken}` },
      });
      expect(list.json()).toEqual([
        {
          credentialId: device.credentialId,
          deviceName: 'My Android phone',
          createdAt: currentTime.toISOString(),
          lastUsedAt: currentTime.toISOString(),
        },
      ]);
    },
  );
  it('requires current primary authentication and does not grant enrollment authority to legacy sessions', async () => {
    const session = await signup();
    currentTime = new Date(currentTime.getTime() + 300_000);
    const request = { deviceName: 'Phone', publicKey: deviceKeys().publicKey };
    expect(
      (
        await post('devices/enrollment/challenge', request, session.accessToken)
      ).json().code,
    ).toBe('RECENT_AUTHENTICATION_REQUIRED');
    expect(
      (await post('devices/enrollment/challenge', request)).statusCode,
    ).toBe(401);
    await database
      .updateTable('auth_sessions')
      .set({ primary_authenticated_at: null })
      .execute();
    currentTime = new Date('2030-01-01T00:00:00Z');
    expect((await me(session.accessToken)).statusCode).toBe(200);
    expect(
      (await post('devices/enrollment/challenge', request, session.accessToken))
        .statusCode,
    ).toBe(403);
  });
  it('accepts fresh password login for enrollment and binds proof to that exact session', async () => {
    const session = await signup(email, true);
    const login = await post('login/password', { contact: email, password });
    const pending = await beginEnrollment(login.json().accessToken);
    expect(
      (
        await post(
          'devices/enrollment/verify',
          proof(pending.challenge, pending.keys),
          session.accessToken,
        )
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await post(
          'devices/enrollment/verify',
          proof(pending.challenge, pending.keys),
          login.json().accessToken,
        )
      ).statusCode,
    ).toBe(201);
  });
  it('refuses enrollment completion after logout or loss of primary freshness', async () => {
    const session = await signup();
    const pending = await beginEnrollment(session.accessToken);
    currentTime = new Date(currentTime.getTime() + 300_000);
    expect(
      (
        await post(
          'devices/enrollment/verify',
          proof(pending.challenge, pending.keys),
          session.accessToken,
        )
      ).statusCode,
    ).toBe(403);
    currentTime = new Date('2030-01-01T00:00:00Z');
    await post('logout', {}, session.accessToken);
    expect(
      (
        await post(
          'devices/enrollment/verify',
          proof(pending.challenge, pending.keys),
          session.accessToken,
        )
      ).statusCode,
    ).toBe(401);
    expect(
      await database
        .selectFrom('auth_device_credentials')
        .selectAll()
        .execute(),
    ).toHaveLength(0);
  });
  it('prevents device sessions from enrolling more devices', async () => {
    const session = await signup();
    const device = await enroll(session.accessToken);
    const login = await post(
      'login/device/verify',
      proof(await loginChallenge(device.credentialId), device.keys),
    );
    const request = {
      deviceName: 'Injected device',
      publicKey: deviceKeys().publicKey,
    };
    expect(
      (
        await post(
          'devices/enrollment/challenge',
          request,
          login.json().accessToken,
        )
      ).statusCode,
    ).toBe(403);
  });
  it('rejects cross-account, cross-device and cross-purpose proof without consuming the legitimate challenge', async () => {
    const session = await signup();
    const other = await signup({ kind: 'email', value: 'other@example.com' });
    const pending = await beginEnrollment(session.accessToken);
    const enrollmentProof = proof(pending.challenge, pending.keys);
    expect(
      (
        await post(
          'devices/enrollment/verify',
          enrollmentProof,
          other.accessToken,
        )
      ).statusCode,
    ).toBe(401);
    expect(
      (await post('login/device/verify', enrollmentProof)).statusCode,
    ).toBe(401);
    expect(
      (
        await post(
          'devices/enrollment/verify',
          enrollmentProof,
          session.accessToken,
        )
      ).statusCode,
    ).toBe(201);
    const device = await enroll(session.accessToken);
    const challenge = await loginChallenge(pending.challenge.credentialId);
    const loginProof = proof(challenge, pending.keys);
    expect(
      (
        await post('login/device/verify', {
          ...loginProof,
          credentialId: device.credentialId,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await post('devices/enrollment/verify', loginProof, session.accessToken))
        .statusCode,
    ).toBe(401);
    expect((await post('login/device/verify', loginProof)).statusCode).toBe(
      200,
    );
  });
  it.each(['enroll', 'login'])(
    'rejects expired %s challenges at the expiry boundary',
    async (purpose) => {
      const session = await signup();
      const pending = await beginEnrollment(session.accessToken);
      if (purpose === 'login') {
        await post(
          'devices/enrollment/verify',
          proof(pending.challenge, pending.keys),
          session.accessToken,
        );
      }
      const challenge =
        purpose === 'enroll'
          ? pending.challenge
          : await loginChallenge(pending.challenge.credentialId);
      currentTime = new Date(challenge.expiresAt);
      const route =
        purpose === 'enroll'
          ? 'devices/enrollment/verify'
          : 'login/device/verify';
      expect(
        (await post(route, proof(challenge, pending.keys), session.accessToken))
          .statusCode,
      ).toBe(401);
    },
  );
  it.each(['enroll', 'login'])(
    'persists five failed signatures for %s even though the response is an error',
    async (purpose) => {
      const session = await signup();
      const pending = await beginEnrollment(session.accessToken);
      if (purpose === 'login') {
        await post(
          'devices/enrollment/verify',
          proof(pending.challenge, pending.keys),
          session.accessToken,
        );
      }
      const challenge =
        purpose === 'enroll'
          ? pending.challenge
          : await loginChallenge(pending.challenge.credentialId);
      const route =
        purpose === 'enroll'
          ? 'devices/enrollment/verify'
          : 'login/device/verify';
      const wrongProof = proof(challenge, deviceKeys());
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect(
          (await post(route, wrongProof, session.accessToken)).statusCode,
        ).toBe(401);
      }
      expect(
        (await post(route, proof(challenge, pending.keys), session.accessToken))
          .statusCode,
      ).toBe(401);
      const stored = await database
        .selectFrom('auth_device_challenges')
        .select('attempts')
        .where('id', '=', challenge.challengeId)
        .executeTakeFirstOrThrow();
      expect(stored.attempts).toBe(5);
    },
  );
  it('allows exactly one session for concurrent copies of the same signed login challenge', async () => {
    const session = await signup();
    const device = await enroll(session.accessToken);
    const body = proof(await loginChallenge(device.credentialId), device.keys);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => post('login/device/verify', body)),
    );
    expect(results.filter((result) => result.statusCode === 200)).toHaveLength(
      1,
    );
    expect(results.filter((result) => result.statusCode === 401)).toHaveLength(
      7,
    );
    expect(
      await database
        .selectFrom('auth_sessions')
        .selectAll()
        .where('device_credential_id', '=', device.credentialId)
        .execute(),
    ).toHaveLength(1);
  });
  it('rolls back challenge consumption and last use if session persistence fails, then permits a safe retry', async () => {
    const session = await signup();
    const device = await enroll(session.accessToken);
    const challenge = await loginChallenge(device.credentialId);
    vi.spyOn(
      AuthenticationRepositoryImpl.prototype,
      'createSession',
    ).mockRejectedValueOnce(new Error('simulated storage failure'));
    expect(
      (await post('login/device/verify', proof(challenge, device.keys)))
        .statusCode,
    ).toBe(503);
    const stored = await database
      .selectFrom('auth_device_challenges')
      .selectAll()
      .where('id', '=', challenge.challengeId)
      .executeTakeFirstOrThrow();
    expect(stored.consumed_at).toBeNull();
    expect(
      (
        await database
          .selectFrom('auth_device_credentials')
          .selectAll()
          .executeTakeFirstOrThrow()
      ).last_used_at,
    ).toBeNull();
    expect(
      (await post('login/device/verify', proof(challenge, device.keys)))
        .statusCode,
    ).toBe(200);
  });
  it('rolls back enrollment if its challenge cannot be consumed', async () => {
    const session = await signup();
    const pending = await beginEnrollment(session.accessToken);
    vi.spyOn(
      PostgresDeviceAuthenticationRepository.prototype,
      'consumeChallenge',
    ).mockRejectedValueOnce(new Error('simulated storage failure'));
    expect(
      (
        await post(
          'devices/enrollment/verify',
          proof(pending.challenge, pending.keys),
          session.accessToken,
        )
      ).statusCode,
    ).toBe(503);
    expect(
      await database
        .selectFrom('auth_device_credentials')
        .selectAll()
        .execute(),
    ).toHaveLength(0);
    expect(
      (
        await post(
          'devices/enrollment/verify',
          proof(pending.challenge, pending.keys),
          session.accessToken,
        )
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await post(
          'devices/enrollment/verify',
          proof(pending.challenge, pending.keys),
          session.accessToken,
        )
      ).statusCode,
    ).toBe(401);
  });
  it('enforces the active-device limit across concurrent primary sessions', async () => {
    await signup(email, true);
    const sessions = await Promise.all(
      Array.from({ length: 6 }, () =>
        post('login/password', { contact: email, password }),
      ),
    );
    const tokens = sessions.map((session) => {
      expect(session.statusCode).toBe(200);
      return session.json().accessToken as string;
    });
    const pending = await Promise.all(
      tokens.map((token) => beginEnrollment(token)),
    );
    const results = await Promise.all(
      pending.map((entry, index) =>
        post(
          'devices/enrollment/verify',
          proof(entry.challenge, entry.keys),
          tokens[index],
        ),
      ),
    );
    expect(results.filter((result) => result.statusCode === 201)).toHaveLength(
      5,
    );
    expect(
      results.filter((result) => result.json().code === 'DEVICE_LIMIT_REACHED'),
    ).toHaveLength(1);
    expect(
      await database
        .selectFrom('auth_device_credentials')
        .selectAll()
        .execute(),
    ).toHaveLength(5);
  });
  it('does not extend challenge expiry while waiting for enrollment locks', async () => {
    const session = await signup();
    const pending = await beginEnrollment(session.accessToken);
    const lock = PostgresDeviceAuthenticationRepository.prototype.lockChallenge;
    vi.spyOn(
      PostgresDeviceAuthenticationRepository.prototype,
      'lockChallenge',
    ).mockImplementationOnce(async function (
      this: PostgresDeviceAuthenticationRepository,
      id: string,
    ) {
      const challenge = await lock.call(this, id);
      currentTime = new Date(currentTime.getTime() + 120_000);
      return challenge;
    });
    expect(
      (
        await post(
          'devices/enrollment/verify',
          proof(pending.challenge, pending.keys),
          session.accessToken,
        )
      ).statusCode,
    ).toBe(401);
    expect(
      await database
        .selectFrom('auth_device_credentials')
        .selectAll()
        .execute(),
    ).toHaveLength(0);
  });
  it.each([' Phone', 'Phone ', 'Phone\nname'])(
    'rejects unsafe or ambiguous device label %j',
    async (deviceName) => {
      const session = await signup();
      expect(
        (
          await post(
            'devices/enrollment/challenge',
            { deviceName, publicKey: deviceKeys().publicKey },
            session.accessToken,
          )
        ).statusCode,
      ).toBe(400);
    },
  );
  it('removes all sessions for a revoked key, including when login races revocation', async () => {
    const session = await signup();
    const device = await enroll(session.accessToken);
    const initial = await post(
      'login/device/verify',
      proof(await loginChallenge(device.credentialId), device.keys),
    );
    const challenges = await Promise.all(
      Array.from({ length: 5 }, () => loginChallenge(device.credentialId)),
    );
    const [removed, ...logins] = await Promise.all([
      revoke(session.accessToken, device.credentialId),
      ...challenges.map((challenge) =>
        post('login/device/verify', proof(challenge, device.keys)),
      ),
    ]);
    expect(removed!.statusCode).toBe(204);
    expect((await me(initial.json().accessToken)).statusCode).toBe(401);
    for (const login of logins.filter((result) => result.statusCode === 200)) {
      expect((await me(login.json().accessToken)).statusCode).toBe(401);
    }
    expect(
      await database
        .selectFrom('auth_sessions')
        .selectAll()
        .where('device_credential_id', '=', device.credentialId)
        .where('revoked_at', 'is', null)
        .execute(),
    ).toHaveLength(0);
    expect(
      (
        await post(
          'login/device/verify',
          proof(await loginChallenge(device.credentialId), device.keys),
        )
      ).statusCode,
    ).toBe(401);
    expect(
      (await revoke(session.accessToken, device.credentialId)).statusCode,
    ).toBe(204);
  });
  it("does not expose or revoke another account's device", async () => {
    const session = await signup();
    const other = await signup({ kind: 'email', value: 'other@example.com' });
    const device = await enroll(session.accessToken);
    expect(
      (await revoke(other.accessToken, device.credentialId)).statusCode,
    ).toBe(204);
    const list = await application.inject({
      method: 'GET',
      url: '/v1/auth/devices',
      headers: { authorization: `Bearer ${other.accessToken}` },
    });
    expect(list.json()).toEqual([]);
    expect(
      (
        await post(
          'login/device/verify',
          proof(await loginChallenge(device.credentialId), device.keys),
        )
      ).statusCode,
    ).toBe(200);
  });
  it('preserves enrollment after logout and issues a fresh session after the old session expires', async () => {
    const session = await signup();
    const device = await enroll(session.accessToken);
    await post('logout', {}, session.accessToken);
    const login = await post(
      'login/device/verify',
      proof(await loginChallenge(device.credentialId), device.keys),
    );
    expect(login.statusCode).toBe(200);
    currentTime = new Date(currentTime.getTime() + 86_400_000);
    expect((await me(login.json().accessToken)).statusCode).toBe(401);
    expect(
      (
        await post(
          'login/device/verify',
          proof(await loginChallenge(device.credentialId), device.keys),
        )
      ).statusCode,
    ).toBe(200);
  });
  it('rejects a disabled account and does not issue a device session', async () => {
    const session = await signup();
    const device = await enroll(session.accessToken);
    const challenge = await loginChallenge(device.credentialId);
    await database
      .updateTable('auth_accounts')
      .set({ disabled_at: currentTime })
      .where('id', '=', session.account.id)
      .execute();
    expect(
      (await post('login/device/verify', proof(challenge, device.keys)))
        .statusCode,
    ).toBe(401);
    expect(
      await database
        .selectFrom('auth_sessions')
        .selectAll()
        .where('device_credential_id', '=', device.credentialId)
        .execute(),
    ).toHaveLength(0);
  });
  it('requires new key material after revocation and rejects duplicate active key enrollment', async () => {
    const session = await signup();
    const device = await enroll(session.accessToken);
    const pending = await beginEnrollment(session.accessToken, device.keys);
    expect(
      (
        await post(
          'devices/enrollment/verify',
          proof(pending.challenge, device.keys),
          session.accessToken,
        )
      ).json().code,
    ).toBe('DEVICE_ALREADY_REGISTERED');
    await revoke(session.accessToken, device.credentialId);
    expect(
      (
        await post(
          'devices/enrollment/verify',
          proof(pending.challenge, device.keys),
          session.accessToken,
        )
      ).json().code,
    ).toBe('DEVICE_ALREADY_REGISTERED');
    await enroll(session.accessToken);
  });
  it('handles unknown credentials generically and throttles concurrent challenge issuance', async () => {
    const credentialId = randomUUID();
    const challenge = await loginChallenge(credentialId);
    expect(
      (await post('login/device/verify', proof(challenge, deviceKeys())))
        .statusCode,
    ).toBe(401);
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        post('login/device/challenge', { credentialId }),
      ),
    );
    expect(results.filter((result) => result.statusCode === 200)).toHaveLength(
      29,
    );
    expect(results.filter((result) => result.statusCode === 429)).toHaveLength(
      1,
    );
    expect(
      results.find((result) => result.statusCode === 429)!.headers[
        'retry-after'
      ],
    ).toBe('600');
  });
  it('supports equivalent UUID casing without weakening key binding', async () => {
    const session = await signup();
    const device = await enroll(session.accessToken);
    const challenge = await loginChallenge(device.credentialId.toUpperCase());
    const body = proof(challenge, device.keys);
    expect(
      (
        await post('login/device/verify', {
          ...body,
          challengeId: body.challengeId.toUpperCase(),
          credentialId: device.credentialId.toUpperCase(),
        })
      ).statusCode,
    ).toBe(200);
  });
  it('rejects forged biometric flags, extra ownership fields, invalid keys and malformed IDs', async () => {
    const session = await signup();
    expect(
      (
        await post(
          'devices/enrollment/challenge',
          {
            deviceName: 'Phone',
            publicKey: deviceKeys().publicKey,
            accountId: session.account.id,
          },
          session.accessToken,
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await post(
          'devices/enrollment/challenge',
          { deviceName: 'Phone', publicKey: 'broken' },
          session.accessToken,
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (await post('login/device/challenge', { credentialId: 123 })).statusCode,
    ).toBe(400);
    expect(
      (
        await post('login/device/verify', {
          credentialId: randomUUID(),
          challengeId: randomUUID(),
          signature: 'AAAA',
          fingerprintVerified: true,
        })
      ).statusCode,
    ).toBe(400);
    expect((await revoke(session.accessToken, 'not-a-uuid')).statusCode).toBe(
      400,
    );
    const service = application.get(DeviceAuthenticationService);
    await expect(
      withValidatedInput(
        DeviceIdentifierDto,
        { credentialId: 'not-a-uuid' },
        (input) =>
          service.requestLogin({
            credentialId: input.credentialId,
            clientIp: '127.0.0.1',
          }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it('documents device DTOs and bearer requirements in the real OpenAPI composition', () => {
    const document = SwaggerModule.createDocument(
      application,
      new DocumentBuilder().addBearerAuth().build(),
    );
    expect(
      document.paths['/v1/auth/devices/enrollment/challenge']!.post!.security,
    ).toEqual([{ bearer: [] }]);
    expect(
      document.paths['/v1/auth/login/device/verify']!.post!.security,
    ).toBeUndefined();
    expect(document.components!.schemas!.DeviceProofDto).toMatchObject({
      required: expect.arrayContaining([
        'credentialId',
        'challengeId',
        'signature',
      ]),
    });
    expect(
      document.paths['/v1/auth/devices/{credentialId}']!.delete!.security,
    ).toEqual([{ bearer: [] }]);
  });
});

/** Request reset using the normal cooldown; the recipient gets a code through the same test delivery port. */
async function passwordResetProof() {
  currentTime = new Date(currentTime.getTime() + 60_000);
  const request = await post('password/forgot', { contact: email });
  expect(request.statusCode).toBe(202);
  const challengeId = request.json().challengeId as string;
  return {
    challengeId,
    code: codes.get(challengeId),
    newPassword: 'a replacement private passphrase',
  };
}

describe('device access after password recovery', () => {
  it('revokes active keys, their sessions, and pending enrollment/login proofs after reset', async () => {
    const owner = await signup(email, true);
    const device = await enroll(owner.accessToken);
    const login = await loginChallenge(device.credentialId);
    const loggedIn = await post(
      'login/device/verify',
      proof(login, device.keys),
    );
    expect(loggedIn.statusCode).toBe(200);
    const pendingLogin = await loginChallenge(device.credentialId);
    const pendingEnrollment = await beginEnrollment(owner.accessToken);
    const reset = await passwordResetProof();
    expect((await post('password/reset', reset)).statusCode).toBe(204);
    expect((await me(owner.accessToken)).statusCode).toBe(401);
    expect((await me(loggedIn.json().accessToken)).statusCode).toBe(401);
    expect(
      (await post('login/device/verify', proof(pendingLogin, device.keys)))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await post(
          'devices/enrollment/verify',
          proof(pendingEnrollment.challenge, pendingEnrollment.keys),
          owner.accessToken,
        )
      ).statusCode,
    ).toBe(401);
    const freshChallenge = await loginChallenge(device.credentialId);
    expect(
      (await post('login/device/verify', proof(freshChallenge, device.keys)))
        .statusCode,
    ).toBe(401);
    const freshSession = await post('login/password', {
      contact: email,
      password: reset.newPassword,
    });
    expect(freshSession.statusCode).toBe(200);
    const list = await application.inject({
      method: 'GET',
      url: '/v1/auth/devices',
      headers: { authorization: `Bearer ${freshSession.json().accessToken}` },
    });
    expect(list.json()).toEqual([]);
    await enroll(freshSession.json().accessToken);
  });
  it('rolls back key revocation when recovery persistence fails', async () => {
    const owner = await signup(email, true);
    const device = await enroll(owner.accessToken);
    const reset = await passwordResetProof();
    const original = AuthenticationRepositoryImpl.prototype.replacePassword;
    vi.spyOn(
      AuthenticationRepositoryImpl.prototype,
      'replacePassword',
    ).mockImplementationOnce(async function (
      this: AuthenticationRepositoryImpl,
      account,
      hash,
      now,
    ) {
      await original.call(this, account, hash, now);
      throw new Error('simulated failure after device revocation');
    });
    expect((await post('password/reset', reset)).statusCode).toBe(503);
    const login = await loginChallenge(device.credentialId);
    expect(
      (await post('login/device/verify', proof(login, device.keys))).statusCode,
    ).toBe(200);
  });
  it('serializes recovery with an in-flight device login and revokes any session it issued', async () => {
    const owner = await signup(email, true);
    const device = await enroll(owner.accessToken);
    const challenge = await loginChallenge(device.credentialId);
    const reset = await passwordResetProof();
    const reached = asyncSignal();
    const release = asyncSignal();
    const original =
      PostgresDeviceAuthenticationRepository.prototype.lockCredential;
    vi.spyOn(
      PostgresDeviceAuthenticationRepository.prototype,
      'lockCredential',
    ).mockImplementationOnce(async function (
      this: PostgresDeviceAuthenticationRepository,
      id,
    ) {
      const credential = await original.call(this, id);
      reached.resolve();
      await release.promise;
      return credential;
    });
    const pendingLogin = post(
      'login/device/verify',
      proof(challenge, device.keys),
    ).then((response) => response);
    await reached.promise;
    const pendingReset = post('password/reset', reset).then(
      (response) => response,
    );
    release.resolve();
    const [loginResult, resetResult] = await Promise.all([
      pendingLogin,
      pendingReset,
    ]);
    expect(loginResult.statusCode).toBe(200);
    expect(resetResult.statusCode).toBe(204);
    expect((await me(loginResult.json().accessToken)).statusCode).toBe(401);
  });
});
