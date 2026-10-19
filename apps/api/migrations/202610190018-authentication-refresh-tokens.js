import { sql } from 'kysely';

/** Add one-use refresh history to existing session families without extending legacy bearer credentials. */
export async function up(database) {
  await sql`
    alter table auth_sessions add column refresh_expires_at timestamptz;
    alter table auth_sessions add constraint auth_sessions_refresh_expiry
      check (refresh_expires_at is null or (refresh_expires_at > created_at and expires_at <= refresh_expires_at));
    create table auth_refresh_tokens (
      token_digest char(64) primary key check (token_digest ~ '^[a-f0-9]{64}$'),
      session_id uuid not null references auth_sessions(id) on delete cascade,
      access_token_digest char(64) not null unique check (access_token_digest ~ '^[a-f0-9]{64}$'),
      created_at timestamptz not null,
      consumed_at timestamptz
    );
    create index auth_refresh_tokens_session on auth_refresh_tokens(session_id);
    create unique index auth_refresh_tokens_current on auth_refresh_tokens(session_id) where consumed_at is null;
    create index auth_sessions_refresh_expiry on auth_sessions(refresh_expires_at)
      where refresh_expires_at is not null;
    create function grant_authentication_refresh_runtime_access(role_name text) returns void
      language plpgsql security definer set search_path = pg_catalog as $$
      begin
        execute format('grant select, insert, update on public.auth_refresh_tokens to %I', role_name);
      end;
      $$;
    revoke all on function grant_authentication_refresh_runtime_access(text) from public;
  `.execute(database);
}
