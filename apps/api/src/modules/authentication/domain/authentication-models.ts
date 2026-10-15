/** A canonical contact identifies one account; linking a second contact is a separate verified workflow. */
export interface Contact {
  readonly kind: 'email' | 'phone';
  readonly value: string;
}
/** An authentication account owns credentials and verified contact identity, not wallet or profile data. */
export interface AuthenticationAccount {
  readonly id: string;
  readonly contact: Contact;
  readonly passwordHash: string | null;
  /** Recovery increments this version to reject proofs captured before the password change. */
  readonly credentialVersion: number;
  readonly createdAt: Date;
  readonly verifiedAt: Date;
  readonly disabledAt: Date | null;
}
/** A code is bound to one contact and one purpose; terminal challenges cannot be redeemed. */
export interface CodeChallenge {
  readonly id: string;
  readonly purpose: 'signup' | 'login' | 'password-reset';
  /** Bind login/recovery to the identity and credential version present at issuance. */
  readonly accountId: string | null;
  readonly credentialVersion: number | null;
  readonly contact: Contact;
  readonly passwordHash: string | null;
  readonly codeDigest: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly attempts: number;
  readonly status: 'pending' | 'ready' | 'consumed' | 'invalidated';
}
/** Persist only a digest of the opaque bearer token; revocation and expiry are authoritative. */
export interface AuthenticationSession {
  readonly deviceCredentialId: string | null;
  readonly primaryAuthenticatedAt: Date | null;
  readonly id: string;
  readonly accountId: string;
  readonly tokenDigest: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}
/** The identity exposed to callers intentionally excludes password hashes and storage state. */
export interface AccountIdentity {
  readonly id: string;
  readonly contact: Contact;
  readonly verifiedAt: string;
}
/** Project a verified account into the public identity contract. */
export function accountIdentity(
  account: AuthenticationAccount,
): AccountIdentity {
  return {
    id: account.id,
    contact: account.contact,
    verifiedAt: account.verifiedAt.toISOString(),
  };
}
