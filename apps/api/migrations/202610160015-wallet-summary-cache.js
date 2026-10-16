import { sql } from 'kysely';

/** Record display-summary invalidations atomically with wallet and ledger changes, including worker and administrator writes. */
export async function up(database) {
  await sql`
    create table wallet_summary_cache_state (
      singleton boolean primary key default true check (singleton),
      namespace uuid not null default gen_random_uuid()
    );
    insert into wallet_summary_cache_state (singleton) values (true);
    create function wallet_summary_cache_namespace() returns uuid
      language sql stable security definer set search_path = pg_catalog
      as 'select namespace from public.wallet_summary_cache_state where singleton';
    create table wallet_summary_cache_invalidations (
      cache_key text primary key,
      version uuid not null default gen_random_uuid(),
      created_at timestamptz not null default now()
    );
    create index wallet_summary_cache_invalidations_created on wallet_summary_cache_invalidations (created_at);

    create function enqueue_wallet_summary_invalidation() returns trigger
      language plpgsql security definer set search_path = pg_catalog as $$
      begin
        insert into public.wallet_summary_cache_invalidations (cache_key)
          values (new.owner_id || ':' || new.currency)
        on conflict (cache_key) do update set version = gen_random_uuid(), created_at = now();
        return null;
      end;
      $$;
    create function enqueue_wallet_balance_invalidation() returns trigger
      language plpgsql security definer set search_path = pg_catalog as $$
      begin
        insert into public.wallet_summary_cache_invalidations (cache_key)
          select wallet.owner_id || ':' || wallet.currency
          from public.ledger_accounts as account
          join public.wallets as wallet on wallet.id = account.wallet_id
          where account.id = new.account_id
        on conflict (cache_key) do update set version = gen_random_uuid(), created_at = now();
        return null;
      end;
      $$;
    revoke all on function enqueue_wallet_summary_invalidation() from public;
    revoke all on function enqueue_wallet_balance_invalidation() from public;
    create trigger enqueue_wallet_summary_invalidation after insert or update on wallets
      for each row execute function enqueue_wallet_summary_invalidation();
    create trigger enqueue_wallet_balance_invalidation after insert or update on ledger_balances
      for each row execute function enqueue_wallet_balance_invalidation();
    insert into wallet_summary_cache_invalidations (cache_key) values ('*');

    create function grant_wallet_summary_cache_runtime_access(runtime_role name) returns void
      language plpgsql set search_path = pg_catalog as $$
      begin
        execute format('grant select, delete on public.wallet_summary_cache_invalidations to %I', runtime_role);
        execute format('grant execute on function public.wallet_summary_cache_namespace() to %I', runtime_role);
      end;
      $$;
    revoke all on function grant_wallet_summary_cache_runtime_access(name) from public;
  `.execute(database);
}
