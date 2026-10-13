import type {
  DeviceChallenge,
  DeviceCredential,
} from '../../domain/device-authentication.js';
import type { AuthenticationRepository } from './authentication.repository.js';

/** Own authoritative device persistence without cache. Session creation and challenge consumption share the transaction. */
export interface DeviceAuthenticationRepository {
  /** Bind both repository contracts to one connection; commit returned failures but roll back exceptions. */
  transaction<T>(
    work: (
      devices: DeviceAuthenticationRepository,
      authentication: AuthenticationRepository,
    ) => Promise<T>,
  ): Promise<T>;
  /** Persist the exact challenge message and its account/session/key bindings. */
  storeChallenge(challenge: DeviceChallenge): Promise<void>;
  /** Lock a challenge for single-use redemption and bounded guesses; requires a transaction. */
  lockChallenge(id: string): Promise<DeviceChallenge | null>;
  /** Increment failed proof attempts while holding its row lock. */
  recordFailedAttempt(id: string): Promise<void>;
  /** Mark a challenge consumed in the same transaction as enrollment or session issuance. */
  consumeChallenge(id: string, now: Date): Promise<void>;
  /** Read a device for challenge issuance; reads do not grant login authority. */
  findCredential(id: string): Promise<DeviceCredential | null>;
  /** Serialize login against device revocation; requires a transaction. */
  lockCredential(id: string): Promise<DeviceCredential | null>;
  /** Count active credentials under the account lock held by enrollment authorization. */
  countActiveCredentials(accountId: string): Promise<number>;
  /** Insert an immutable account/key binding; return false if its ID or public key is already registered. */
  createCredential(device: DeviceCredential): Promise<boolean>;
  /** Return a bounded active-device list for the authorized owner. */
  listCredentials(accountId: string): Promise<DeviceCredential[]>;
  /** Record use as part of the transaction that issues its session. */
  markUsed(id: string, now: Date): Promise<void>;
  /** Revoke the locked credential, pending login challenges, and every session issued through it atomically. */
  revokeCredential(id: string, now: Date): Promise<void>;
}
