import type { EnrollmentSession } from '../domain/device-authentication.js';
import { sql, type Kysely, type Selectable } from 'kysely';
import type {
  AuthenticationAccount,
  AuthenticationSession,
  CodeChallenge,
  Contact,
  AccountIdentity,
} from '../domain/authentication-models.js';
import type { AuthenticationRepository } from './contracts/authentication.repository.js';
import type { AuthenticationDatabase } from './authentication-database.js';
import type { SessionIdentityCache } from './contracts/session-identity-cache.js';
import type { SessionCacheInvalidationRepository } from './contracts/session-cache-invalidation.repository.js';

/**
 * Implement {@link AuthenticationRepository} with authoritative PostgreSQL persistence and Redis cache coordination.
 * Identity cache hits use Redis only; committed mutations invalidate through a durable outbox.
 * Credentials, attempts and transaction reads bypass cache. Transaction callbacks share one
 * connection; services retain credential and authorization decisions.
 */
export class AuthenticationRepositoryImpl implements AuthenticationRepository {
  /** Borrow the lifecycle-managed pool or a transaction connection; this repository never closes either. */
  constructor(
    private readonly database: Kysely<AuthenticationDatabase>,
    private readonly sessionCache?: SessionIdentityCache,
    private readonly invalidations?: SessionCacheInvalidationRepository,
  ) {}
  /** Expose the atomic boundary through the contract without leaking SQL clients to workflows. */
  transaction<T>(
    work: (repository: AuthenticationRepository) => Promise<T>,
  ): Promise<T> {
    return this.withTransaction(work);
  }

  /** Bind repository queries to one connection and reuse an outer transaction without committing it early. */
  private async withTransaction<T>(
    work: (repository: AuthenticationRepositoryImpl) => Promise<T>,
  ): Promise<T> {
    if (this.database.isTransaction) {
      return work(this);
    }
    const result = await this.database
      .transaction()
      .execute((transaction) =>
        work(new AuthenticationRepositoryImpl(transaction)),
      );
    await this.invalidations?.flush();
    return result;
  }
  /** Find canonical contact credentials without using Redis or transport DTOs. */
  async findAccount(contact: Contact): Promise<AuthenticationAccount | null> {
    const row = await this.database
      .selectFrom('auth_accounts')
      .selectAll()
      .where('contact_kind', '=', contact.kind)
      .where('contact_value', '=', contact.value)
      .executeTakeFirst();
    return row ? mapAccount(row) : null;
  }
  /** Resolve an account through a registered device's persisted owner rather than caller-supplied identity. */
  async findAccountById(id: string): Promise<AuthenticationAccount | null> {
    const row = await this.database
      .selectFrom('auth_accounts')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? mapAccount(row) : null;
  }
  /** Recovery and enrollment acquire the account before session/device locks, preserving one lock order. */
  async lockAccountById(id: string): Promise<AuthenticationAccount | null> {
    if (!this.database.isTransaction) {
      throw new Error('Account locking requires a transaction.');
    }
    const row = await this.database
      .selectFrom('auth_accounts')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    return row ? mapAccount(row) : null;
  }
  /** Lock account first, then recheck and lock the live session; revocation cannot race enrollment completion. */
  async lockEnrollmentSession(
    tokenDigest: string,
    now: Date,
  ): Promise<EnrollmentSession | null> {
    if (!this.database.isTransaction) {
      throw new Error('Enrollment authorization requires a transaction.');
    }
    const identity = await this.findSessionIdentity(tokenDigest, now);
    if (!identity || !(await this.lockAccountById(identity.id))) {
      return null;
    }
    const row = await this.database
      .selectFrom('auth_sessions')
      .innerJoin(
        'auth_accounts',
        'auth_accounts.id',
        'auth_sessions.account_id',
      )
      .selectAll('auth_accounts')
      .select([
        'auth_sessions.id as session_id',
        'auth_sessions.primary_authenticated_at',
        'auth_sessions.expires_at as session_expires_at',
      ])
      .where('token_digest', '=', tokenDigest)
      .where('expires_at', '>', now)
      .where('auth_sessions.revoked_at', 'is', null)
      .where('disabled_at', 'is', null)
      .forUpdate('auth_sessions')
      .executeTakeFirst();
    return row
      ? {
          id: row.session_id,
          account: mapAccount(row),
          primaryAuthenticatedAt: row.primary_authenticated_at,
          expiresAt: row.session_expires_at,
        }
      : null;
  }
  /** Rely on the unique contact constraint to settle concurrent signup safely. */
  async createAccount(
    account: AuthenticationAccount,
  ): Promise<AuthenticationAccount | null> {
    const row = await this.database
      .insertInto('auth_accounts')
      .values({
        id: account.id,
        contact_kind: account.contact.kind,
        contact_value: account.contact.value,
        password_hash: account.passwordHash,
        credential_version: account.credentialVersion,
        created_at: account.createdAt,
        verified_at: account.verifiedAt,
        disabled_at: account.disabledAt,
      })
      .onConflict((conflict) =>
        conflict.columns(['contact_kind', 'contact_value']).doNothing(),
      )
      .returningAll()
      .executeTakeFirst();
    return row ? mapAccount(row) : null;
  }
  /** Supersede older pending or ready codes and insert their replacement in one transaction. */
  async storeChallenge(challenge: CodeChallenge): Promise<void> {
    await this.withTransaction(async (repository) => {
      await repository.database
        .updateTable('auth_challenges')
        .set({ status: 'invalidated', password_hash: null })
        .where('contact_kind', '=', challenge.contact.kind)
        .where('contact_value', '=', challenge.contact.value)
        .where('purpose', '=', challenge.purpose)
        .where('status', 'in', ['pending', 'ready'])
        .execute();
      await repository.database
        .insertInto('auth_challenges')
        .values({
          id: challenge.id,
          contact_kind: challenge.contact.kind,
          contact_value: challenge.contact.value,
          purpose: challenge.purpose,
          account_id: challenge.accountId,
          credential_version: challenge.credentialVersion,
          password_hash: challenge.passwordHash,
          code_digest: challenge.codeDigest,
          created_at: challenge.createdAt,
          expires_at: challenge.expiresAt,
          attempts: challenge.attempts,
          status: challenge.status,
        })
        .execute();
    });
  }
  /** Serialize redemption and wrong-guess updates on the same row until the outer transaction commits. */
  async lockChallenge(id: string): Promise<CodeChallenge | null> {
    if (!this.database.isTransaction) {
      throw new Error('Challenge locking requires a transaction.');
    }
    const row = await this.database
      .selectFrom('auth_challenges')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      contact: {
        kind: readContactKind(row.contact_kind),
        value: row.contact_value,
      },
      purpose: readChallengePurpose(row.purpose),
      accountId: row.account_id,
      credentialVersion: row.credential_version,
      passwordHash: row.password_hash,
      codeDigest: row.code_digest,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      attempts: row.attempts,
      status: readChallengeStatus(row.status),
    };
  }
  /** Compare-and-set prevents late delivery acknowledgement from resurrecting an invalidated code. */
  async changeChallengeStatus(
    id: string,
    previous: CodeChallenge['status'],
    next: CodeChallenge['status'],
  ): Promise<void> {
    await this.database
      .updateTable('auth_challenges')
      .set({
        status: next,
        ...(next === 'ready' ? {} : { password_hash: null }),
      })
      .where('id', '=', id)
      .where('status', '=', previous)
      .execute();
  }
  /** Increment a failed guess while the caller holds the challenge row lock. */
  async recordWrongCode(id: string): Promise<void> {
    await this.database
      .updateTable('auth_challenges')
      .set({ attempts: sql`attempts + 1` })
      .where('id', '=', id)
      .where('status', '=', 'ready')
      .execute();
  }
  /** Update the locked account and revoke its existing access in one transaction; no wallet or payment records are touched. */
  async replacePassword(
    account: AuthenticationAccount,
    passwordHash: string,
    now: Date,
  ): Promise<boolean> {
    if (!this.database.isTransaction) {
      throw new Error('Password recovery requires a transaction.');
    }
    const updated = await this.database
      .updateTable('auth_accounts')
      .set({
        password_hash: passwordHash,
        credential_version: account.credentialVersion + 1,
      })
      .where('id', '=', account.id)
      .where('credential_version', '=', account.credentialVersion)
      .where('disabled_at', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (!updated) {
      return false;
    }
    await this.database
      .updateTable('auth_device_credentials')
      .set({ revoked_at: now })
      .where('account_id', '=', account.id)
      .where('revoked_at', 'is', null)
      .execute();
    await this.database
      .updateTable('auth_sessions')
      .set({ revoked_at: now })
      .where('account_id', '=', account.id)
      .where('revoked_at', 'is', null)
      .execute();
    // Older codes fail their version check; pending device proofs lose their session/key authority.
    // Avoid locking other challenges here: their own redemption locks precede the account lock.
    return true;
  }
  /** The shared account lock makes insertion serialize with recovery's version update and session revocation. */
  async createSession(
    session: AuthenticationSession,
    credentialVersion: number,
  ): Promise<boolean> {
    const result =
      await sql`insert into auth_sessions (id, account_id, token_digest, created_at, expires_at, revoked_at, device_credential_id, primary_authenticated_at)
      select ${session.id}::uuid, id, ${session.tokenDigest}, ${session.createdAt}, ${session.expiresAt}, null, ${session.deviceCredentialId}::uuid, ${session.primaryAuthenticatedAt}
      from auth_accounts where id = ${session.accountId}::uuid and disabled_at is null and credential_version = ${credentialVersion} for share returning id`.execute(
        this.database,
      );
    return result.rows.length === 1;
  }
  /** Require PostgreSQL for current-state authorization; eligible cached reads use generation-fenced fills and SQL-free hits. */
  async findSessionIdentity(
    tokenDigest: string,
    now: Date,
    requireCurrentState = false,
  ): Promise<AccountIdentity | null> {
    if (
      requireCurrentState ||
      this.database.isTransaction ||
      !this.sessionCache
    ) {
      return (
        (await this.readSessionIdentity(tokenDigest, now))?.identity ?? null
      );
    }
    const cached = await this.sessionCache.read(tokenDigest, now);
    if (cached?.snapshot) {
      return cached.snapshot.identity;
    }
    const snapshot = await this.readSessionIdentity(tokenDigest, now);
    if (!snapshot) {
      return null;
    }
    if (cached) {
      await this.sessionCache.write(tokenDigest, snapshot, now, cached.ticket);
    }
    return snapshot.identity;
  }

  /** Load only public identity and session expiry on a miss, keeping credential columns out of Redis. */
  private async readSessionIdentity(tokenDigest: string, now: Date) {
    const row = await this.database
      .selectFrom('auth_sessions')
      .innerJoin(
        'auth_accounts',
        'auth_accounts.id',
        'auth_sessions.account_id',
      )
      .select([
        'auth_accounts.id',
        'auth_accounts.contact_kind',
        'auth_accounts.contact_value',
        'auth_accounts.verified_at',
        'auth_sessions.expires_at',
      ])
      .where('token_digest', '=', tokenDigest)
      .where('expires_at', '>', now)
      .where('revoked_at', 'is', null)
      .where('disabled_at', 'is', null)
      .executeTakeFirst();
    if (!row) {
      return null;
    }
    return {
      identity: {
        id: row.id,
        contact: {
          kind: readContactKind(row.contact_kind),
          value: row.contact_value,
        },
        verifiedAt: row.verified_at.toISOString(),
      },
      expiresAtMs: row.expires_at.getTime(),
    };
  }
  /** Revoke one digest without making account existence observable to the caller. */
  async revokeSession(tokenDigest: string, now: Date): Promise<void> {
    await this.database
      .updateTable('auth_sessions')
      .set({ revoked_at: now })
      .where('token_digest', '=', tokenDigest)
      .where('revoked_at', 'is', null)
      .execute();
    if (!this.database.isTransaction) {
      await this.invalidations?.flush();
    }
  }
  /** Atomically increment a shared fixed-window counter, resetting only after its existing window expires. */
  async takeRateLimit(
    key: string,
    limit: number,
    windowSeconds: number,
    now: Date,
  ): Promise<number> {
    const endsAt = new Date(now.getTime() + windowSeconds * 1000);
    const row = await this.database
      .insertInto('auth_rate_limits')
      .values({ key, attempts: 1, window_ends_at: endsAt })
      .onConflict((conflict) =>
        conflict.column('key').doUpdateSet({
          attempts: sql`case when auth_rate_limits.window_ends_at <= ${now} then 1 else auth_rate_limits.attempts + 1 end`,
          window_ends_at: sql`case when auth_rate_limits.window_ends_at <= ${now} then ${endsAt} else auth_rate_limits.window_ends_at end`,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    if (row.attempts <= limit) {
      return 0;
    }
    return Math.max(
      1,
      Math.ceil((row.window_ends_at.getTime() - now.getTime()) / 1000),
    );
  }
}

/** Translate persistence column names at the boundary so SQL models cannot escape into services. */
function mapAccount(
  row: Selectable<AuthenticationDatabase['auth_accounts']>,
): AuthenticationAccount {
  return {
    id: row.id,
    contact: {
      kind: readContactKind(row.contact_kind),
      value: row.contact_value,
    },
    passwordHash: row.password_hash,
    credentialVersion: row.credential_version,
    createdAt: row.created_at,
    verifiedAt: row.verified_at,
    disabledAt: row.disabled_at,
  };
}

/** Check the persisted contact discriminator before exposing a domain value. */
function readContactKind(value: string): Contact['kind'] {
  if (value === 'email' || value === 'phone') {
    return value;
  }
  throw new Error('Invalid stored contact kind.');
}
/** Check the persisted code purpose independently of HTTP input. */
function readChallengePurpose(value: string): CodeChallenge['purpose'] {
  if (value === 'signup' || value === 'login' || value === 'password-reset') {
    return value;
  }
  throw new Error('Invalid stored challenge purpose.');
}
/** Reject corrupt or unsupported challenge states at the persistence boundary. */
function readChallengeStatus(value: string): CodeChallenge['status'] {
  if (
    value === 'pending' ||
    value === 'ready' ||
    value === 'consumed' ||
    value === 'invalidated'
  ) {
    return value;
  }
  throw new Error('Invalid stored challenge state.');
}
