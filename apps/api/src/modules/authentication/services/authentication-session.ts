import {
  accountIdentity,
  type AccountIdentity,
  type AuthenticationAccount,
} from '../domain/authentication-models.js';
import { authenticationPolicy } from '../domain/authentication-policy.js';
import { invalidCredentials } from '../domain/authentication-error.js';
import type { AuthenticationSecrets } from '../ports/authentication.ports.js';
import type { AuthenticationRepository } from '../repositories/contracts/authentication.repository.js';

/** Return the raw token only to the authenticated caller; clients must store it in protected device storage. */
export interface AuthenticationResult {
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresInSeconds: number;
  readonly account: AccountIdentity;
}

/** Create a fresh revocable session using the caller's transaction; persist only its token digest. */
export async function issueSession(
  repository: AuthenticationRepository,
  secrets: AuthenticationSecrets,
  account: AuthenticationAccount,
  now: Date,
): Promise<AuthenticationResult> {
  const accessToken = secrets.sessionToken();
  const expiresInSeconds = authenticationPolicy.sessionLifetimeSeconds;
  const saved = await repository.createSession({
    id: secrets.id(),
    accountId: account.id,
    tokenDigest: secrets.tokenDigest(accessToken),
    createdAt: now,
    expiresAt: new Date(now.getTime() + expiresInSeconds * 1000),
    revokedAt: null,
  });
  if (!saved) {
    throw invalidCredentials();
  }
  return {
    accessToken,
    tokenType: 'Bearer',
    expiresInSeconds,
    account: accountIdentity(account),
  };
}
