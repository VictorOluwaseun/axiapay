/** Real authenticated customers for funding contract tests; fixture setup never bypasses the HTTP session guard. */
import { randomBytes, randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { expect } from 'vitest';
import { NodeAuthenticationSecrets } from '../../src/modules/authentication/security/node-authentication-secrets.js';
import type { WalletTestDatabase } from '../../../../packages/payments-runtime/tests/support/wallet-test-database.js';

/** A fixture identity still authenticates through the real opaque-session guard. */
export interface FundingCustomer {
  readonly actorId: string;
  readonly token: string;
  readonly walletId: string;
}

/** Provision a verified account/session in test storage, then create its wallet through the public HTTP route. */
export async function createFundingCustomer(
  application: NestFastifyApplication,
  database: WalletTestDatabase,
  currency = 'NGN',
): Promise<FundingCustomer> {
  const actorId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  await database.administrator
    .insertInto('auth_accounts')
    .values({
      id: actorId,
      contact_kind: 'email',
      contact_value: `${actorId}@example.com`,
      password_hash: null,
      created_at: now,
      verified_at: now,
      disabled_at: null,
    })
    .execute();
  await database.administrator
    .insertInto('auth_sessions')
    .values({
      id: randomUUID(),
      account_id: actorId,
      token_digest: new NodeAuthenticationSecrets('11'.repeat(32)).tokenDigest(
        token,
      ),
      created_at: now,
      expires_at: new Date(now.getTime() + 3600000),
      revoked_at: null,
    })
    .execute();
  const response = await application.inject({
    method: 'POST',
    url: '/v1/wallets',
    headers: { authorization: `Bearer ${token}` },
    payload: { currency },
  });
  expect(response.statusCode).toBe(201);
  return { actorId, token, walletId: response.json().id };
}
