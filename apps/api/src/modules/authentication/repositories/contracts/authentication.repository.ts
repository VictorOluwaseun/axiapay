import type {
  AuthenticationAccount,
  AuthenticationSession,
  CodeChallenge,
  Contact,
} from '../../domain/authentication-models.js';

/** Own authoritative authentication data access. Reads bypass cache; transaction callbacks share one connection. */
export interface AuthenticationRepository {
  /** Commit all callback writes together; callback results allow failed attempts to commit before an error is returned. */
  transaction<T>(
    work: (repository: AuthenticationRepository) => Promise<T>,
  ): Promise<T>;
  /** Read a contact's credentials without exposing transport or SQL models. */
  findAccount(contact: Contact): Promise<AuthenticationAccount | null>;
  /** Create a verified identity; return null on contact conflict without overwriting existing credentials. */
  createAccount(
    account: AuthenticationAccount,
  ): Promise<AuthenticationAccount | null>;
  /** Atomically supersede earlier codes for this purpose and persist a pending delivery. */
  storeChallenge(challenge: CodeChallenge): Promise<void>;
  /** Lock one challenge inside a transaction so attempts and successful consumption are serialized. */
  lockChallenge(id: string): Promise<CodeChallenge | null>;
  /** Change state only if the expected previous state still holds. */
  changeChallengeStatus(
    id: string,
    previous: CodeChallenge['status'],
    next: CodeChallenge['status'],
  ): Promise<void>;
  /** Persist a wrong guess within the challenge lock's transaction. */
  recordWrongCode(id: string): Promise<void>;
  /** Save a session for an active account; return false if the account became unavailable. */
  createSession(session: AuthenticationSession): Promise<boolean>;
  /** Resolve a live, unrevoked token only when its account is still active. */
  findSessionIdentity(
    tokenDigest: string,
    now: Date,
  ): Promise<AuthenticationAccount | null>;
  /** Revoke a token idempotently; unknown and expired tokens disclose no extra information. */
  revokeSession(tokenDigest: string, now: Date): Promise<void>;
  /** Atomically consume a fixed-window allowance across API processes; return seconds until retry when exhausted. */
  takeRateLimit(
    key: string,
    limit: number,
    windowSeconds: number,
    now: Date,
  ): Promise<number>;
}
