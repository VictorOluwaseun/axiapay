import { sql } from 'kysely';

/** Add immutable device public keys, one-use challenges, and session provenance without reauthorizing legacy sessions. */
export async function up(database) {
  await sql`
    create table auth_device_credentials (
      id uuid primary key,
      account_id uuid not null references auth_accounts(id),
      device_name varchar(80) not null check (length(device_name) > 0),
      public_key varchar(256) not null,
      key_fingerprint char(64) not null unique,
      created_at timestamptz not null,
      last_used_at timestamptz,
      revoked_at timestamptz,
      unique (id, account_id)
    );
    create index auth_device_credentials_owner on auth_device_credentials(account_id, created_at) where revoked_at is null;
    alter table auth_sessions add column primary_authenticated_at timestamptz;
    alter table auth_sessions add column device_credential_id uuid;
    alter table auth_sessions add constraint auth_sessions_device_owner
      foreign key (device_credential_id, account_id) references auth_device_credentials(id, account_id);
    alter table auth_sessions add constraint auth_sessions_authentication_source
      check (device_credential_id is null or primary_authenticated_at is null);
    create index auth_sessions_device on auth_sessions(device_credential_id) where device_credential_id is not null;
    create table auth_device_challenges (
      id uuid primary key,
      purpose varchar(6) not null check (purpose in ('enroll', 'login')),
      credential_id uuid not null,
      account_id uuid references auth_accounts(id),
      enrollment_session_id uuid references auth_sessions(id),
      public_key varchar(256),
      device_name varchar(80),
      message varchar(2048) not null,
      expires_at timestamptz not null,
      attempts integer not null default 0 check (attempts between 0 and 5),
      consumed_at timestamptz,
      check (
        (purpose = 'enroll' and account_id is not null and enrollment_session_id is not null and public_key is not null and device_name is not null)
        or (purpose = 'login' and enrollment_session_id is null and public_key is null and device_name is null)
      )
    );
    create index auth_device_challenges_expiry on auth_device_challenges(expires_at);
    create index auth_device_challenges_credential on auth_device_challenges(credential_id) where consumed_at is null;
  `.execute(database);
}
