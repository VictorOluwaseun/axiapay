import type { EnrollmentSession } from '../../domain/device-authentication.js';
import type {
  AuthenticationAccount,
  AuthenticationSession,
  CodeChallenge,
  Contact,
  AccountIdentity,
} from '../../domain/authentication-models.js';

/** Own authoritative authentication data; identity hits use Redis, and committed changes invalidate through a durable outbox. Transaction callbacks share one connection. */
export interface AuthenticationRepository {
  /** Resolve device ownership to the current account; disabled state remains authoritative in the service and session insert. */
  findAccountById(id: string): Promise<AuthenticationAccount | null>;
  /** Lock current account state before credential/session/device mutations; requires a transaction. */
  lockAccountById(id: string): Promise<AuthenticationAccount | null>;
  /** Lock the active session and account for enrollment, serializing logout and concurrent device-count decisions. */
  lockEnrollmentSession(
    tokenDigest: string,
    now: Date,
  ): Promise<EnrollmentSession | null>;
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
  /** Replace the locked active account's password/version and revoke its sessions/device keys in the caller's transaction. */
  replacePassword(
    account: AuthenticationAccount,
    passwordHash: string,
    now: Date,
  ): Promise<boolean>;
  /** Lock/check the active account version before insertion; stale pre-reset proof cannot create a surviving session. */
  createSession(
    session: AuthenticationSession,
    credentialVersion: number,
  ): Promise<boolean>;
  /** Resolve a signed cached identity, or require current PostgreSQL state for protected writes. Transaction-local reads always bypass cache. */
  findSessionIdentity(
    tokenDigest: string,
    now: Date,
    requireCurrentState?: boolean,
  ): Promise<AccountIdentity | null>;
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
