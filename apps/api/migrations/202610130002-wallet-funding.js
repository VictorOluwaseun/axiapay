/** Persist funding intent identities and verified partner movements; no destructive financial rollback exists. */
import { sql } from 'kysely';

/** Install immutable financial bindings, durable initialization claims, and independent duplicate-payment constraints. */
export async function up(database) {
  await sql`
    create table wallet_funding_requests (
      id uuid primary key,
      owner_id text not null,
      wallet_id uuid not null,
      currency text not null,
      amount_minor_units bigint not null check (amount_minor_units > 0),
      partner text not null check (partner in ('opay', 'paystack')),
      environment text not null check (environment in ('test', 'live')),
      partner_account_id uuid not null,
      payer_email text not null,
      request_key text not null check (length(request_key) between 1 and 200),
      request_fingerprint text not null,
      initialization_started_at timestamptz,
      checkout_url text,
      created_at timestamptz not null default now(),
      unique (owner_id, request_key),
      foreign key (wallet_id, currency) references wallets(id, currency),
      foreign key (partner_account_id, currency) references ledger_accounts(id, currency),
      unique (id, partner, environment)
    );
    create table wallet_funding_payments (
      funding_request_id uuid primary key,
      partner text not null,
      environment text not null,
      external_movement_id text not null check (length(external_movement_id) between 1 and 200),
      verified_at timestamptz not null default now(),
      unique (partner, environment, external_movement_id),
      foreign key (funding_request_id, partner, environment)
        references wallet_funding_requests(id, partner, environment)
    );
    create function guard_funding_request() returns trigger language plpgsql as $$
    begin
      -- Serialize initial account bindings so concurrent deployments cannot reuse a clearing account across realms.
      if tg_op = 'INSERT' then
        perform pg_advisory_xact_lock(hashtextextended(new.partner_account_id::text, 0));
      end if;
      if tg_op = 'INSERT' and exists (
        select 1 from wallet_funding_requests where partner_account_id = new.partner_account_id
          and (partner, environment) is distinct from (new.partner, new.environment)
      ) then
        raise exception 'partner clearing account realm is immutable' using errcode = '23514';
      end if;
      if tg_op = 'INSERT' and (not exists (select 1 from wallets where id = new.wallet_id and owner_id = new.owner_id)
        or not exists (select 1 from ledger_accounts where id = new.partner_account_id and account_kind = 'partner_funds')) then
        raise exception 'invalid funding binding' using errcode = '23514';
      end if;
      if tg_op = 'INSERT' then return new; end if;
      if (to_jsonb(new) - 'initialization_started_at' - 'checkout_url')
         is distinct from (to_jsonb(old) - 'initialization_started_at' - 'checkout_url') then
        raise exception 'funding identity is immutable' using errcode = '23514';
      end if;
      if old.initialization_started_at is not null and new.initialization_started_at is distinct from old.initialization_started_at then
        raise exception 'funding initialization claim is immutable' using errcode = '23514';
      end if;
      if old.checkout_url is not null and new.checkout_url is distinct from old.checkout_url then
        raise exception 'funding checkout is immutable' using errcode = '23514';
      end if;
      return new;
    end $$;
    create trigger protect_funding_request before insert or update on wallet_funding_requests
      for each row execute function guard_funding_request();
    create trigger immutable_funding_payments before update or delete on wallet_funding_payments
      for each row execute function reject_wallet_history_change();
    create trigger no_delete_funding_requests before delete on wallet_funding_requests
      for each row execute function reject_wallet_history_change();
    create trigger no_truncate_funding_requests before truncate on wallet_funding_requests
      execute function reject_wallet_history_change();
    create trigger no_truncate_funding_payments before truncate on wallet_funding_payments
      execute function reject_wallet_history_change();

    create function grant_funding_runtime_access(runtime_role name) returns void language plpgsql as $$
    begin
      execute format('grant select, insert on wallet_funding_requests, wallet_funding_payments to %I', runtime_role);
      execute format('grant update(initialization_started_at, checkout_url) on wallet_funding_requests to %I', runtime_role);
    end $$;
    revoke all on function grant_funding_runtime_access(name) from public;
  `.execute(database);
}
