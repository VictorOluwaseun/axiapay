import { expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { promises as fs } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { startWalletTestDatabase } from '../../../../packages/payments-runtime/tests/support/wallet-test-database.js';
import { DatabaseConnection } from '@axiapay/payments-runtime/infrastructure/database/database.module';
import { AuthenticationModule } from '../../src/modules/authentication/authentication.module.js';
import { AUTHENTICATION } from '../../src/modules/authentication/authentication.tokens.js';
import { ArgonPasswordHasher } from '../../src/modules/authentication/security/argon-password-hasher.js';
import { RequestValidationModule } from '../../src/bootstrap/request-validation.module.js';
import { SessionCacheInvalidationConnection } from '../../src/infrastructure/database/session-cache-invalidation.connection.js';
import { RedisCacheConnection } from '../../src/infrastructure/redis/redis-cache-connection.js';
import { REMOTE_CONFIG_REPOSITORY } from '../../src/modules/remote-config/remote-config.tokens.js';
import { TestRemoteConfigRepository } from '../support/remote-config.js';
import type { SessionIdentityCache } from '../../src/modules/authentication/repositories/contracts/session-identity-cache.js';

/** Opt-in physical-phone fixture: real API and restricted PostgreSQL, no development accounts or Firebase writes. */
it.skipIf(process.env.AXIAPAY_MOBILE_REFRESH_DEVICE !== 'true')(
  'serves the real refresh protocol to an explicitly selected physical phone',
  async () => {
    const readyFile = process.env.AXIAPAY_MOBILE_REFRESH_READY_FILE;
    const doneFile = process.env.AXIAPAY_MOBILE_REFRESH_DONE_FILE;
    if (!readyFile || !doneFile) {
      throw new Error(
        'Explicit ready/done paths are required for the opt-in phone fixture.',
      );
    }
    const database = await startWalletTestDatabase();
    let application: NestFastifyApplication | undefined;
    try {
      await sql`grant select, insert, update, delete on auth_accounts, auth_sessions, auth_challenges, auth_rate_limits, auth_device_credentials, auth_device_challenges to wallet_runtime;
      select grant_authentication_refresh_runtime_access('wallet_runtime');`.execute(
        database.administrator,
      );
      const now = new Date();
      const accountId = randomUUID();
      await database.administrator
        .insertInto('auth_accounts')
        .values({
          id: accountId,
          contact_kind: 'email',
          contact_value: 'refresh-device@example.test',
          password_hash: await new ArgonPasswordHasher().hash(
            'test-only-mobile-refresh-password',
          ),
          created_at: now,
          verified_at: now,
          disabled_at: null,
        })
        .execute();
      const uncached: SessionIdentityCache = {
        canSynchronize: false,
        recoveryGeneration: 0,
        requiresRecoveryReset: false,
        /** Physical-phone protocol checks use authoritative SQL; independent Redis replicas have their own suite. */
        async read() {
          return null;
        },
        /** No cache entry is populated by this fixture. */
        async write() {},
        /** No shared development cache is invalidated. */
        async invalidate() {},
        /** This cache remains disabled for the whole fixture. */
        pause() {},
        /** This cache remains disabled for the whole fixture. */
        activate() {},
      };
      const module = await Test.createTestingModule({
        imports: [RequestValidationModule, AuthenticationModule],
      })
        .overrideProvider(AUTHENTICATION.codeDelivery)
        .useValue({
          /** The phone fixture uses password login; it must never deliver an OTP or simulated SMS. */
          async send() {
            throw new Error(
              'Code delivery is outside the isolated refresh fixture.',
            );
          },
        })
        .overrideProvider(DatabaseConnection)
        .useValue({ database: database.database })
        .overrideProvider(SessionCacheInvalidationConnection)
        .useValue({ database: database.database })
        .overrideProvider(RedisCacheConnection)
        .useValue({})
        .overrideProvider(AUTHENTICATION.sessionIdentityCache)
        .useValue(uncached)
        .overrideProvider(REMOTE_CONFIG_REPOSITORY)
        .useValue(new TestRemoteConfigRepository())
        .compile();
      application = module.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter(),
        { logger: false },
      );
      application.setGlobalPrefix('api/v1');
      await application.listen({ port: 0, host: '127.0.0.1' });
      const address = application.getHttpServer().address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected a local TCP listener.');
      }
      await fs.writeFile(readyFile, JSON.stringify({ port: address.port }), {
        mode: 0o600,
      });
      const deadline = Date.now() + 150_000;
      while (Date.now() < deadline) {
        const done = await fs.readFile(doneFile, 'utf8').catch(() => '');
        if (done === 'passed') {
          break;
        }
        if (done === 'stop') {
          throw new Error('Physical-phone fixture was stopped.');
        }
        await delay(250);
      }
      expect(await fs.readFile(doneFile, 'utf8').catch(() => '')).toBe(
        'passed',
      );
      const families = await database.administrator
        .selectFrom('auth_sessions')
        .selectAll()
        .execute();
      expect(families).toHaveLength(1);
      expect(families[0]?.revoked_at).not.toBeNull();
      const proofs = await database.administrator
        .selectFrom('auth_refresh_tokens')
        .selectAll()
        .execute();
      expect(proofs).toHaveLength(2);
      expect(proofs.filter((proof) => proof.consumed_at !== null)).toHaveLength(
        1,
      );
    } finally {
      await application?.close();
      await database.stop();
      await fs.rm(readyFile, { force: true });
    }
  },
  180_000,
);
