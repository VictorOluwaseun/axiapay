/** Add first-party airtime/data catalogue revisions, review quotes, durable payment identities and append-only provider evidence. */
import { sql } from 'kysely';

/** Install storage invariants without enabling products, calling providers, or modifying existing wallet balances. */
export async function up(database) {
  await sql`
    create table service_catalog_products (
      id uuid primary key,
      service_type text not null check (service_type in ('airtime', 'data')),
      network_code text not null check (network_code ~ '^[a-z0-9][a-z0-9-]{0,49}$'),
      display_name text not null check (length(display_name) between 1 and 200),
      currency text not null check (currency ~ '^[A-Z]{3}$'),
      fixed_price_minor_units bigint,
      minimum_amount_minor_units bigint not null check (minimum_amount_minor_units > 0),
      maximum_amount_minor_units bigint not null check (maximum_amount_minor_units >= minimum_amount_minor_units),
      amount_step_minor_units bigint not null check (amount_step_minor_units > 0),
      fee_minor_units bigint not null check (fee_minor_units >= 0),
      allowance_label text,
      validity_seconds integer,
      quote_lifetime_seconds integer not null check (quote_lifetime_seconds between 1 and 3600),
      provider_key text not null check (length(provider_key) between 1 and 100),
      provider_product_code text not null check (length(provider_product_code) between 1 and 200),
      is_enabled boolean not null default false,
      created_at timestamptz not null default now(),
      check (maximum_amount_minor_units::numeric + fee_minor_units <= 9223372036854775807),
      check ((service_type = 'airtime' and fixed_price_minor_units is null and allowance_label is null and validity_seconds is null)
        or (service_type = 'data' and fixed_price_minor_units is not null and fixed_price_minor_units = minimum_amount_minor_units
          and fixed_price_minor_units = maximum_amount_minor_units and length(allowance_label) between 1 and 200
          and allowance_label is not null and validity_seconds > 0 and validity_seconds is not null))
    );
    create index service_catalog_enabled on service_catalog_products(service_type, network_code, id) where is_enabled;

    create table service_payment_quotes (
      id uuid primary key,
      owner_id text not null,
      wallet_id uuid not null,
      product_id uuid not null references service_catalog_products(id),
      recipient_phone_number text not null check (recipient_phone_number ~ '^[+][1-9][0-9]{7,14}$'),
      currency text not null,
      principal_minor_units bigint not null check (principal_minor_units > 0),
      fee_minor_units bigint not null check (fee_minor_units >= 0),
      total_debit_minor_units bigint not null check (total_debit_minor_units > 0),
      created_at timestamptz not null,
      expires_at timestamptz not null check (expires_at > created_at),
      foreign key(wallet_id, currency) references wallets(id, currency),
      check (principal_minor_units::numeric + fee_minor_units = total_debit_minor_units),
      unique(id, owner_id)
    );
    create table service_payments (
      id uuid primary key,
      owner_id text not null,
      quote_id uuid not null unique,
      request_key text not null check (length(request_key) between 1 and 200),
      partner_account_id uuid not null references ledger_accounts(id),
      fee_account_id uuid references ledger_accounts(id),
      created_at timestamptz not null default now(),
      submission_started_at timestamptz,
      unique(owner_id, request_key),
      foreign key(quote_id, owner_id) references service_payment_quotes(id, owner_id)
    );
    create table service_payment_outcomes (
      payment_id uuid primary key references service_payments(id),
      provider_key text not null,
      outcome text not null check (outcome in ('succeeded', 'failed')),
      provider_transaction_reference text not null check (length(provider_transaction_reference) between 1 and 200),
      evidence_reference text not null check (length(evidence_reference) between 1 and 200),
      recorded_at timestamptz not null default now(),
      unique(provider_key, provider_transaction_reference)
    );

    create function guard_service_product() returns trigger language plpgsql as $$
    begin
      if (to_jsonb(new) - 'is_enabled') is distinct from (to_jsonb(old) - 'is_enabled') then
        raise exception 'product revisions are immutable' using errcode = '23514';
      end if;
      return new;
    end $$;
    create trigger protect_service_product before update on service_catalog_products for each row execute function guard_service_product();
    create function guard_service_quote() returns trigger language plpgsql as $$
    declare product service_catalog_products%rowtype;
    begin
      select * into strict product from service_catalog_products where id = new.product_id for share;
      if not product.is_enabled or new.currency <> product.currency or new.fee_minor_units <> product.fee_minor_units
        or new.principal_minor_units < product.minimum_amount_minor_units or new.principal_minor_units > product.maximum_amount_minor_units
        or mod(new.principal_minor_units - product.minimum_amount_minor_units, product.amount_step_minor_units) <> 0
        or new.expires_at <> new.created_at + make_interval(secs => product.quote_lifetime_seconds)
        or not exists(select 1 from wallets where id = new.wallet_id and owner_id = new.owner_id) then
        raise exception 'invalid review terms' using errcode = '23514';
      end if;
      return new;
    end $$;
    create trigger protect_service_quote before insert on service_payment_quotes for each row execute function guard_service_quote();
    create function guard_service_submission() returns trigger language plpgsql as $$
    begin
      if tg_op = 'INSERT' and not exists (select 1 from service_payment_quotes quote join ledger_accounts account
          on account.id = new.partner_account_id and account.currency = quote.currency and account.account_kind = 'partner_funds'
          where quote.id = new.quote_id and (quote.fee_minor_units = 0 or exists (select 1 from ledger_accounts fee
            where fee.id = new.fee_account_id and fee.currency = quote.currency and fee.account_kind = 'fee_income'))) then
        raise exception 'invalid payment settlement accounts' using errcode = '23514';
      end if;
      if tg_op = 'INSERT' then return new; end if;
      if (to_jsonb(new) - 'submission_started_at') is distinct from (to_jsonb(old) - 'submission_started_at')
        or old.submission_started_at is not null or new.submission_started_at is null then
        raise exception 'payment identity and dispatch claim are immutable' using errcode = '23514';
      end if;
      if not exists (
        select 1 from service_payment_quotes quote join wallet_reservations reservation
          on reservation.wallet_id = quote.wallet_id and reservation.currency = quote.currency
          and reservation.amount_minor_units = quote.total_debit_minor_units
        where quote.id = new.quote_id and reservation.payment_reference = new.id::text
          and reservation.reservation_status = 'reserved'
      ) then
        raise exception 'submission requires matching held funds' using errcode = '23514';
      end if;
      return new;
    end $$;
    create trigger protect_service_submission before insert or update on service_payments for each row execute function guard_service_submission();
    create function guard_service_outcome() returns trigger language plpgsql as $$
    begin
      if not exists (select 1 from service_payments payment join service_payment_quotes quote on quote.id = payment.quote_id
        join service_catalog_products product on product.id = quote.product_id
        where payment.id = new.payment_id and payment.submission_started_at is not null and product.provider_key = new.provider_key) then
        raise exception 'outcome requires correlated submitted instruction' using errcode = '23514';
      end if;
      return new;
    end $$;
    create trigger protect_service_outcome before insert on service_payment_outcomes for each row execute function guard_service_outcome();
    create trigger immutable_service_quotes before update or delete on service_payment_quotes for each row execute function reject_wallet_history_change();
    create trigger immutable_service_outcomes before update or delete on service_payment_outcomes for each row execute function reject_wallet_history_change();
    create trigger no_delete_service_products before delete on service_catalog_products for each row execute function reject_wallet_history_change();
    create trigger no_delete_service_payments before delete on service_payments for each row execute function reject_wallet_history_change();
    create trigger no_truncate_service_products before truncate on service_catalog_products execute function reject_wallet_history_change();
    create trigger no_truncate_service_quotes before truncate on service_payment_quotes execute function reject_wallet_history_change();
    create trigger no_truncate_service_payments before truncate on service_payments execute function reject_wallet_history_change();
    create trigger no_truncate_service_outcomes before truncate on service_payment_outcomes execute function reject_wallet_history_change();
    create function grant_service_payments_runtime_access(runtime_role name) returns void language plpgsql as $$
    begin
      execute format('grant select on service_catalog_products, service_payment_quotes, service_payments, service_payment_outcomes to %I', runtime_role);
      execute format('grant insert on service_payment_quotes, service_payments, service_payment_outcomes to %I', runtime_role);
      -- PostgreSQL row locking requires UPDATE privilege on at least one column. Guards keep these identities immutable.
      execute format('grant update(id) on service_catalog_products, service_payment_quotes to %I', runtime_role);
      execute format('grant update(submission_started_at) on service_payments to %I', runtime_role);
    end $$;
    revoke all on function grant_service_payments_runtime_access(name) from public;
  `.execute(database);
}
