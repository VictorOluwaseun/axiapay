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

/** Create a revocable session in the caller's transaction; device login never grants fresh primary-authentication authority. */
export async function issueSession(
  repository: AuthenticationRepository,
  secrets: AuthenticationSecrets,
  account: AuthenticationAccount,
  now: Date,
  deviceCredentialId: string | null = null,
): Promise<AuthenticationResult> {
  const accessToken = secrets.sessionToken();
  const expiresInSeconds = authenticationPolicy.sessionLifetimeSeconds;
  const saved = await repository.createSession(
    {
      deviceCredentialId,
      primaryAuthenticatedAt: deviceCredentialId === null ? now : null,
      id: secrets.id(),
      accountId: account.id,
      tokenDigest: secrets.tokenDigest(accessToken),
      createdAt: now,
      expiresAt: new Date(now.getTime() + expiresInSeconds * 1000),
      revokedAt: null,
    },
    account.credentialVersion,
  );
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
