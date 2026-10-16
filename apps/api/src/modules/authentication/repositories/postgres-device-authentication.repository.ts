import { sql, type Kysely, type Selectable } from 'kysely';
import type { DeviceAuthenticationRepository } from './contracts/device-authentication.repository.js';
import type { AuthenticationRepository } from './contracts/authentication.repository.js';
import type { AuthenticationDatabase } from './authentication-database.js';
import type {
  DeviceChallenge,
  DeviceCredential,
} from '../domain/device-authentication.js';
import { deviceAuthenticationPolicy } from '../domain/device-authentication.js';
import { AuthenticationRepositoryImpl } from './authentication.repository.impl.js';
import type { SessionCacheInvalidationRepository } from './contracts/session-cache-invalidation.repository.js';

/** Persist device credentials and challenges directly in PostgreSQL; borrow the pool and never cache authentication authority. */
export class PostgresDeviceAuthenticationRepository implements DeviceAuthenticationRepository {
  /** Accept a managed connection; lifecycle remains with DatabaseModule. */
  constructor(
    private readonly database: Kysely<AuthenticationDatabase>,
    private readonly invalidations?: SessionCacheInvalidationRepository,
  ) {}
  /** Reuse outer transactions and bind session writes to the same connection as device changes. */
  async transaction<T>(
    work: (
      devices: DeviceAuthenticationRepository,
      authentication: AuthenticationRepository,
    ) => Promise<T>,
  ): Promise<T> {
    if (this.database.isTransaction) {
      return work(this, new AuthenticationRepositoryImpl(this.database));
    }
    const result = await this.database
      .transaction()
      .execute((transaction) =>
        work(
          new PostgresDeviceAuthenticationRepository(transaction),
          new AuthenticationRepositoryImpl(transaction),
        ),
      );
    await this.invalidations?.flush();
    return result;
  }
  /** Store server-owned purpose and exact signable bytes; pending enrollment does not create a usable credential. */
  async storeChallenge(challenge: DeviceChallenge): Promise<void> {
    await this.database
      .insertInto('auth_device_challenges')
      .values({
        id: challenge.id,
        purpose: challenge.purpose,
        credential_id: challenge.credentialId,
        account_id: challenge.accountId,
        enrollment_session_id: challenge.enrollmentSessionId,
        public_key: challenge.publicKey,
        device_name: challenge.deviceName,
        message: challenge.message,
        expires_at: challenge.expiresAt,
        attempts: challenge.attempts,
        consumed_at: challenge.consumedAt,
      })
      .execute();
  }
  /** Hold the challenge row lock until the caller's device/session transaction commits. */
  async lockChallenge(id: string): Promise<DeviceChallenge | null> {
    this.requireTransaction();
    const row = await this.database
      .selectFrom('auth_device_challenges')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) {
      return null;
    }
    if (row.purpose !== 'enroll' && row.purpose !== 'login') {
      throw new Error('Invalid stored device challenge purpose.');
    }
    return {
      id: row.id,
      purpose: row.purpose,
      credentialId: row.credential_id,
      accountId: row.account_id,
      enrollmentSessionId: row.enrollment_session_id,
      publicKey: row.public_key,
      deviceName: row.device_name,
      message: row.message,
      expiresAt: row.expires_at,
      attempts: row.attempts,
      consumedAt: row.consumed_at,
    };
  }
  /** Commit wrong-signature budgets even when the service subsequently returns an authentication error. */
  async recordFailedAttempt(id: string): Promise<void> {
    await this.database
      .updateTable('auth_device_challenges')
      .set({ attempts: sql`attempts + 1` })
      .where('id', '=', id)
      .execute();
  }
  /** Consume under the row lock, with rollback if a later enrollment or session write fails. */
  async consumeChallenge(id: string, now: Date): Promise<void> {
    await this.database
      .updateTable('auth_device_challenges')
      .set({ consumed_at: now })
      .where('id', '=', id)
      .execute();
  }
  /** Resolve a public credential identifier without treating existence as authorization. */
  async findCredential(id: string): Promise<DeviceCredential | null> {
    const row = await this.database
      .selectFrom('auth_device_credentials')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? mapCredential(row) : null;
  }
  /** All login and revocation operations acquire this lock before challenge or session writes. */
  async lockCredential(id: string): Promise<DeviceCredential | null> {
    this.requireTransaction();
    const row = await this.database
      .selectFrom('auth_device_credentials')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    return row ? mapCredential(row) : null;
  }
  /** Enrollment's account lock serializes this count with credential insertion across sessions. */
  async countActiveCredentials(accountId: string): Promise<number> {
    const row = await this.database
      .selectFrom('auth_device_credentials')
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .where('account_id', '=', accountId)
      .where('revoked_at', 'is', null)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }
  /** Keep revoked-key tombstones to prevent silently reactivating a previously removed credential. */
  async createCredential(device: DeviceCredential): Promise<boolean> {
    const row = await this.database
      .insertInto('auth_device_credentials')
      .values({
        id: device.id,
        account_id: device.accountId,
        device_name: device.deviceName,
        public_key: device.publicKey,
        key_fingerprint: device.keyFingerprint,
        created_at: device.createdAt,
        last_used_at: device.lastUsedAt,
        revoked_at: device.revokedAt,
      })
      .onConflict((conflict) => conflict.doNothing())
      .returning('id')
      .executeTakeFirst();
    return row !== undefined;
  }
  /** Only active registrations are shown; private key material is never stored. */
  async listCredentials(accountId: string): Promise<DeviceCredential[]> {
    const rows = await this.database
      .selectFrom('auth_device_credentials')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('revoked_at', 'is', null)
      .orderBy('created_at', 'desc')
      .orderBy('id')
      .limit(deviceAuthenticationPolicy.maxActiveDevices)
      .execute();
    return rows.map(mapCredential);
  }
  /** Last-use timestamps commit alongside the corresponding session and challenge consumption. */
  async markUsed(id: string, now: Date): Promise<void> {
    await this.database
      .updateTable('auth_device_credentials')
      .set({ last_used_at: now })
      .where('id', '=', id)
      .execute();
  }
  /** The caller holds the device lock, so concurrent login either precedes revocation or observes it. */
  async revokeCredential(id: string, now: Date): Promise<void> {
    this.requireTransaction();
    await this.database
      .updateTable('auth_device_credentials')
      .set({ revoked_at: now })
      .where('id', '=', id)
      .where('revoked_at', 'is', null)
      .execute();
    await this.database
      .updateTable('auth_sessions')
      .set({ revoked_at: now })
      .where('device_credential_id', '=', id)
      .where('revoked_at', 'is', null)
      .execute();
    await this.database
      .updateTable('auth_device_challenges')
      .set({ consumed_at: now })
      .where('credential_id', '=', id)
      .where('consumed_at', 'is', null)
      .execute();
  }
  /** Refuse row-lock and revocation operations outside the repository's atomic boundary. */
  private requireTransaction(): void {
    if (!this.database.isTransaction) {
      throw new Error('Device authentication requires a transaction.');
    }
  }
}

/** Map storage column names without exposing SQL rows to services or controllers. */
function mapCredential(
  row: Selectable<AuthenticationDatabase['auth_device_credentials']>,
): DeviceCredential {
  return {
    id: row.id,
    accountId: row.account_id,
    deviceName: row.device_name,
    publicKey: row.public_key,
    keyFingerprint: row.key_fingerprint,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}
