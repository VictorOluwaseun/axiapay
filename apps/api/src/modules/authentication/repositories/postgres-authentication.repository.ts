import type { EnrollmentSession } from '../domain/device-authentication.js';
import { sql, type Kysely, type Selectable } from 'kysely';
import type {
  AuthenticationAccount,
  AuthenticationSession,
  CodeChallenge,
  Contact,
} from '../domain/authentication-models.js';
import type { AuthenticationRepository } from './contracts/authentication.repository.js';
import type { AuthenticationDatabase } from './authentication-database.js';

/**
 * Implement {@link AuthenticationRepository} directly with PostgreSQL queries and domain mapping.
 * Reads bypass cache so revocation and attempts take effect immediately. Transaction callbacks
 * share one connection; services retain credential and authorization decisions.
 */
export class PostgresAuthenticationRepository implements AuthenticationRepository {
  /** Borrow the lifecycle-managed pool or a transaction connection; this repository never closes either. */
  constructor(private readonly database: Kysely<AuthenticationDatabase>) {}
  /** Expose the atomic boundary through the contract without leaking SQL clients to workflows. */
  transaction<T>(
    work: (repository: AuthenticationRepository) => Promise<T>,
  ): Promise<T> {
    return this.withTransaction(work);
  }

  /** Bind repository queries to one connection and reuse an outer transaction without committing it early. */
  private async withTransaction<T>(
    work: (repository: PostgresAuthenticationRepository) => Promise<T>,
  ): Promise<T> {
    if (this.database.isTransaction) {
      return work(this);
    }
    return this.database
      .transaction()
      .execute((transaction) =>
        work(new PostgresAuthenticationRepository(transaction)),
      );
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
  /** Lock the session and account in one transaction; session revocation cannot race enrollment completion. */
  async lockEnrollmentSession(
    tokenDigest: string,
    now: Date,
  ): Promise<EnrollmentSession | null> {
    if (!this.database.isTransaction) {
      throw new Error('Enrollment authorization requires a transaction.');
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
      .forUpdate(['auth_accounts', 'auth_sessions'])
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
  /** Insert from the active account row so a disabled identity cannot acquire a usable new session. */
  async createSession(session: AuthenticationSession): Promise<boolean> {
    const result =
      await sql`insert into auth_sessions (id, account_id, token_digest, created_at, expires_at, revoked_at, device_credential_id, primary_authenticated_at)
      select ${session.id}::uuid, id, ${session.tokenDigest}, ${session.createdAt}, ${session.expiresAt}, null, ${session.deviceCredentialId}::uuid, ${session.primaryAuthenticatedAt}
      from auth_accounts where id = ${session.accountId}::uuid and disabled_at is null returning id`.execute(
        this.database,
      );
    return result.rows.length === 1;
  }
  /** Join current account state on every authentication; expiry and revocation are never cached. */
  async findSessionIdentity(
    tokenDigest: string,
    now: Date,
  ): Promise<AuthenticationAccount | null> {
    const row = await this.database
      .selectFrom('auth_sessions')
      .innerJoin(
        'auth_accounts',
        'auth_accounts.id',
        'auth_sessions.account_id',
      )
      .selectAll('auth_accounts')
      .where('token_digest', '=', tokenDigest)
      .where('expires_at', '>', now)
      .where('revoked_at', 'is', null)
      .where('disabled_at', 'is', null)
      .executeTakeFirst();
    return row ? mapAccount(row) : null;
  }
  /** Revoke one digest without making account existence observable to the caller. */
  async revokeSession(tokenDigest: string, now: Date): Promise<void> {
    await this.database
      .updateTable('auth_sessions')
      .set({ revoked_at: now })
      .where('token_digest', '=', tokenDigest)
      .where('revoked_at', 'is', null)
      .execute();
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
  if (value === 'signup' || value === 'login') {
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
