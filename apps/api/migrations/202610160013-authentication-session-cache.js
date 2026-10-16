import { sql } from 'kysely';

/** Install a transactional cache revision so Redis entries cannot outlive authoritative session/account changes. */
export async function up(database) {
  await sql`
    create table auth_session_cache_state (
      singleton boolean primary key default true check (singleton),
      revision uuid not null default gen_random_uuid()
    );
    insert into auth_session_cache_state (singleton) values (true);

    create function auth_session_cache_revision() returns uuid
      language sql stable security definer set search_path = pg_catalog
      as 'select revision from public.auth_session_cache_state where singleton';

    create function invalidate_auth_session_cache() returns trigger
      language plpgsql security definer set search_path = pg_catalog as $$
      begin
        update public.auth_session_cache_state set revision = gen_random_uuid() where singleton;
        if not found then
          raise exception 'Authentication cache revision is unavailable';
        end if;
        return null;
      end;
      $$;
    revoke all on function invalidate_auth_session_cache() from public;

    create trigger invalidate_account_session_cache
      before update or delete or truncate on auth_accounts
      for each statement execute function invalidate_auth_session_cache();
    create trigger invalidate_session_identity_cache
      before update or delete or truncate on auth_sessions
      for each statement execute function invalidate_auth_session_cache();
  `.execute(database);
}

/** Remove only cache metadata and its triggers during an explicit rollback; accounts and sessions are preserved. */
export async function down(database) {
  await sql`
    drop trigger invalidate_session_identity_cache on auth_sessions;
    drop trigger invalidate_account_session_cache on auth_accounts;
    drop function invalidate_auth_session_cache();
    drop function auth_session_cache_revision();
    drop table auth_session_cache_state;
  `.execute(database);
}
