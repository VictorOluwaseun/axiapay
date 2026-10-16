import { sql } from 'kysely';

/** Replace read-time database revisions with targeted, transactionally recorded Redis invalidation work. */
export async function up(database) {
  await sql`
    drop trigger invalidate_session_identity_cache on auth_sessions;
    drop trigger invalidate_account_session_cache on auth_accounts;
    drop function invalidate_auth_session_cache();
    drop function auth_session_cache_revision();
    alter table auth_session_cache_state rename column revision to namespace;
    create function auth_session_cache_namespace() returns uuid
      language sql stable security definer set search_path = pg_catalog
      as 'select namespace from public.auth_session_cache_state where singleton';

    create table auth_session_cache_invalidations (
      token_digest varchar(64) primary key check (token_digest = '*' or token_digest ~ '^[a-f0-9]{64}$'),
      version uuid not null default gen_random_uuid(),
      created_at timestamptz not null default now()
    );
    create index auth_session_cache_invalidations_created on auth_session_cache_invalidations (created_at);
    create function enqueue_session_identity_invalidation() returns trigger
      language plpgsql security definer set search_path = pg_catalog as $$
      begin
        insert into public.auth_session_cache_invalidations (token_digest) values (old.token_digest)
        on conflict (token_digest) do update set version = gen_random_uuid(), created_at = now();
        if tg_op = 'UPDATE' and new.token_digest is distinct from old.token_digest then
          insert into public.auth_session_cache_invalidations (token_digest) values (new.token_digest)
          on conflict (token_digest) do update set version = gen_random_uuid(), created_at = now();
        end if;
        return null;
      end;
      $$;
    create function enqueue_account_session_invalidations() returns trigger
      language plpgsql security definer set search_path = pg_catalog as $$
      begin
        insert into public.auth_session_cache_invalidations (token_digest)
        select token_digest from public.auth_sessions where account_id = old.id order by token_digest
        on conflict (token_digest) do update set version = gen_random_uuid(), created_at = now();
        return null;
      end;
      $$;
    create function enqueue_session_cache_reset() returns trigger
      language plpgsql security definer set search_path = pg_catalog as $$
      begin
        insert into public.auth_session_cache_invalidations (token_digest) values ('*')
        on conflict (token_digest) do update set version = gen_random_uuid(), created_at = now();
        return null;
      end;
      $$;
    revoke all on function enqueue_session_identity_invalidation() from public;
    revoke all on function enqueue_account_session_invalidations() from public;
    revoke all on function enqueue_session_cache_reset() from public;
    create trigger enqueue_session_identity_invalidation after update or delete on auth_sessions
      for each row execute function enqueue_session_identity_invalidation();
    create trigger enqueue_account_session_invalidations after update on auth_accounts
      for each row execute function enqueue_account_session_invalidations();
    create trigger enqueue_account_cache_reset after truncate on auth_accounts
      for each statement execute function enqueue_session_cache_reset();
    create trigger enqueue_session_cache_reset after truncate on auth_sessions
      for each statement execute function enqueue_session_cache_reset();
    insert into auth_session_cache_invalidations (token_digest) values ('*');
  `.execute(database);
}
