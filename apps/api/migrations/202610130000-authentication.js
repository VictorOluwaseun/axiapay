import { sql } from 'kysely';

/** Add verified identities, single-use challenges, revocable sessions, and durable attempt budgets. */
export async function up(database) {
  await database.schema
    .createTable('auth_accounts')
    .addColumn('id', 'uuid', (column) => column.primaryKey())
    .addColumn('contact_kind', 'varchar(5)', (column) => column.notNull())
    .addColumn('contact_value', 'varchar(254)', (column) => column.notNull())
    .addColumn('password_hash', 'text')
    .addColumn('created_at', 'timestamptz', (column) => column.notNull())
    .addColumn('verified_at', 'timestamptz', (column) => column.notNull())
    .addColumn('disabled_at', 'timestamptz')
    .addUniqueConstraint('auth_accounts_contact_unique', [
      'contact_kind',
      'contact_value',
    ])
    .addCheckConstraint(
      'auth_accounts_contact_kind',
      sql`contact_kind in ('email', 'phone')`,
    )
    .execute();
  await database.schema
    .createTable('auth_challenges')
    .addColumn('id', 'uuid', (column) => column.primaryKey())
    .addColumn('contact_kind', 'varchar(5)', (column) => column.notNull())
    .addColumn('contact_value', 'varchar(254)', (column) => column.notNull())
    .addColumn('purpose', 'varchar(6)', (column) => column.notNull())
    .addColumn('password_hash', 'text')
    .addColumn('code_digest', 'char(64)', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull())
    .addColumn('expires_at', 'timestamptz', (column) => column.notNull())
    .addColumn('attempts', 'integer', (column) => column.notNull())
    .addColumn('status', 'varchar(11)', (column) => column.notNull())
    .addCheckConstraint(
      'auth_challenges_kind',
      sql`contact_kind in ('email', 'phone')`,
    )
    .addCheckConstraint(
      'auth_challenges_purpose',
      sql`purpose in ('signup', 'login')`,
    )
    .addCheckConstraint(
      'auth_challenges_status',
      sql`status in ('pending', 'ready', 'consumed', 'invalidated')`,
    )
    .addCheckConstraint('auth_challenges_attempts', sql`attempts >= 0`)
    .addCheckConstraint('auth_challenges_expiry', sql`expires_at > created_at`)
    .execute();
  await sql`create unique index auth_challenges_current on auth_challenges (contact_kind, contact_value, purpose) where status in ('pending', 'ready')`.execute(
    database,
  );
  await database.schema
    .createIndex('auth_challenges_expiry')
    .on('auth_challenges')
    .column('expires_at')
    .execute();
  await database.schema
    .createTable('auth_sessions')
    .addColumn('id', 'uuid', (column) => column.primaryKey())
    .addColumn('account_id', 'uuid', (column) =>
      column.notNull().references('auth_accounts.id').onDelete('cascade'),
    )
    .addColumn('token_digest', 'char(64)', (column) =>
      column.notNull().unique(),
    )
    .addColumn('created_at', 'timestamptz', (column) => column.notNull())
    .addColumn('expires_at', 'timestamptz', (column) => column.notNull())
    .addColumn('revoked_at', 'timestamptz')
    .addCheckConstraint('auth_sessions_expiry', sql`expires_at > created_at`)
    .execute();
  await database.schema
    .createIndex('auth_sessions_account')
    .on('auth_sessions')
    .column('account_id')
    .execute();
  await database.schema
    .createIndex('auth_sessions_expiry')
    .on('auth_sessions')
    .column('expires_at')
    .execute();
  await database.schema
    .createTable('auth_rate_limits')
    .addColumn('key', 'char(64)', (column) => column.primaryKey())
    .addColumn('attempts', 'integer', (column) => column.notNull())
    .addColumn('window_ends_at', 'timestamptz', (column) => column.notNull())
    .addCheckConstraint('auth_rate_limits_attempts', sql`attempts > 0`)
    .execute();
  await database.schema
    .createIndex('auth_rate_limits_expiry')
    .on('auth_rate_limits')
    .column('window_ends_at')
    .execute();
}

/** Remove authentication data only during an explicitly reviewed rollback; this destroys accounts and sessions. */
export async function down(database) {
  await database.schema.dropTable('auth_rate_limits').execute();
  await database.schema.dropTable('auth_sessions').execute();
  await database.schema.dropTable('auth_challenges').execute();
  await database.schema.dropTable('auth_accounts').execute();
}
