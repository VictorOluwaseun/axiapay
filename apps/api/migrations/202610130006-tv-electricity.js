/** Extend the existing first-party payment schema with verified bill recipients and separate immutable fulfilment receipts. */
import { sql } from 'kysely';

/** Preserve mobile history and wallet balances while adding TV packages and prepaid/postpaid electricity products; seed no billers or integrations. */
export async function up(database) {
  await sql`
    -- Replace only checks that restrict the old two-category catalogue, preserving its monetary bounds.
    do $$ declare constraint_record record; begin
      for constraint_record in select conname from pg_constraint where conrelid = 'service_catalog_products'::regclass
        and contype = 'c' and pg_get_constraintdef(oid) like '%service_type%' loop
        execute format('alter table service_catalog_products drop constraint %I', constraint_record.conname);
      end loop;
    end $$;
    alter table service_catalog_products alter column network_code drop not null,
      add column biller_code text,
      add column electricity_meter_type text,
      add column account_validation_lifetime_seconds integer;
    alter table service_catalog_products add constraint service_catalog_category check(service_type in ('airtime', 'data', 'tv', 'electricity')),
      add constraint service_catalog_recipient_kind check (
        (service_type in ('airtime', 'data') and network_code is not null and biller_code is null
          and electricity_meter_type is null and account_validation_lifetime_seconds is null)
        or (service_type in ('tv', 'electricity') and network_code is null and biller_code is not null
          and biller_code ~ '^[a-z0-9][a-z0-9-]{0,49}$' and account_validation_lifetime_seconds is not null
          and account_validation_lifetime_seconds between 1 and 3600
          and ((service_type = 'tv' and electricity_meter_type is null)
            or (service_type = 'electricity' and electricity_meter_type is not null and electricity_meter_type in ('prepaid', 'postpaid'))))
      ),
      add constraint service_catalog_price_kind check (
        (service_type in ('airtime', 'electricity') and fixed_price_minor_units is null and allowance_label is null and validity_seconds is null)
        or (service_type = 'data' and fixed_price_minor_units is not null and fixed_price_minor_units = minimum_amount_minor_units
          and fixed_price_minor_units = maximum_amount_minor_units and allowance_label is not null
          and length(allowance_label) between 1 and 200 and validity_seconds is not null and validity_seconds > 0)
        or (service_type = 'tv' and fixed_price_minor_units is not null and fixed_price_minor_units = minimum_amount_minor_units
          and fixed_price_minor_units = maximum_amount_minor_units and allowance_label is null and (validity_seconds is null or validity_seconds > 0))
      );
    create index service_catalog_billers on service_catalog_products(service_type, biller_code, electricity_meter_type, id) where is_enabled;

    create table service_bill_account_validations (
      id uuid primary key,
      owner_id text not null,
      product_id uuid not null references service_catalog_products(id),
      account_number text not null check (length(account_number) between 1 and 100 and account_number = btrim(account_number)
        and account_number !~ '[[:cntrl:]]'),
      customer_name text not null check (length(customer_name) between 1 and 200 and length(btrim(customer_name)) > 0),
      service_address text check (length(service_address) between 1 and 500),
      evidence_reference text not null check (length(evidence_reference) between 1 and 200),
      verified_at timestamptz not null,
      expires_at timestamptz not null check(expires_at > verified_at),
      unique(id, owner_id, product_id)
    );
    alter table service_payment_quotes alter column recipient_phone_number drop not null,
      add column account_validation_id uuid,
      add constraint service_quote_verified_recipient foreign key(account_validation_id, owner_id, product_id)
        references service_bill_account_validations(id, owner_id, product_id),
      add constraint service_quote_recipient_kind check (
        (recipient_phone_number is not null and account_validation_id is null)
        or (recipient_phone_number is null and account_validation_id is not null)
      );
    create function guard_bill_account_validation() returns trigger language plpgsql as $$
    declare product service_catalog_products%rowtype;
    begin
      select * into strict product from service_catalog_products where id = new.product_id for share;
      if not product.is_enabled or product.service_type not in ('tv', 'electricity')
        or new.expires_at <> new.verified_at + make_interval(secs => product.account_validation_lifetime_seconds) then
        raise exception 'invalid bill validation binding' using errcode = '23514';
      end if;
      return new;
    end $$;
    create trigger protected_bill_account_validation before insert on service_bill_account_validations
      for each row execute function guard_bill_account_validation();
    create trigger immutable_bill_account_validations before update or delete on service_bill_account_validations
      for each row execute function reject_wallet_history_change();
    create trigger no_truncate_bill_account_validations before truncate on service_bill_account_validations
      execute function reject_wallet_history_change();

    create or replace function guard_service_quote() returns trigger language plpgsql as $$
    declare product service_catalog_products%rowtype; validation service_bill_account_validations%rowtype;
      expected_expiry timestamptz;
    begin
      select * into strict product from service_catalog_products where id = new.product_id for share;
      expected_expiry := new.created_at + make_interval(secs => product.quote_lifetime_seconds);
      if product.service_type in ('airtime', 'data') and (new.recipient_phone_number is null or new.account_validation_id is not null) then
        raise exception 'mobile quote requires phone recipient' using errcode = '23514';
      end if;
      if product.service_type in ('tv', 'electricity') then
        select * into strict validation from service_bill_account_validations where id = new.account_validation_id
          and owner_id = new.owner_id and product_id = new.product_id;
        expected_expiry := least(expected_expiry, validation.expires_at);
      end if;
      if not product.is_enabled or new.currency <> product.currency or new.fee_minor_units <> product.fee_minor_units
        or new.principal_minor_units < product.minimum_amount_minor_units or new.principal_minor_units > product.maximum_amount_minor_units
        or mod(new.principal_minor_units - product.minimum_amount_minor_units, product.amount_step_minor_units) <> 0
        or new.expires_at <> expected_expiry
        or not exists(select 1 from wallets where id = new.wallet_id and owner_id = new.owner_id) then
        raise exception 'invalid review terms' using errcode = '23514';
      end if;
      return new;
    end $$;

    create table service_payment_fulfilments (
      payment_id uuid primary key references service_payment_outcomes(payment_id),
      fulfilment jsonb not null check(jsonb_typeof(fulfilment) = 'object'),
      recorded_at timestamptz not null default now()
    );
    create function guard_service_fulfilment() returns trigger language plpgsql as $$
    begin
      if not exists (select 1 from service_payment_outcomes outcome join service_payments payment on payment.id = outcome.payment_id
        join service_payment_quotes quote on quote.id = payment.quote_id join service_catalog_products product on product.id = quote.product_id
        where payment.id = new.payment_id and outcome.outcome = 'succeeded' and (
          (product.service_type = 'tv' and new.fulfilment->>'fulfilmentType' = 'tv_subscription')
          or (product.service_type = 'electricity' and new.fulfilment->>'fulfilmentType' = 'electricity_' || product.electricity_meter_type)
        )) then
        raise exception 'fulfilment requires correlated successful bill payment' using errcode = '23514';
      end if;
      return new;
    end $$;
    create trigger protect_service_fulfilment before insert on service_payment_fulfilments for each row execute function guard_service_fulfilment();
    create trigger immutable_service_fulfilments before update or delete on service_payment_fulfilments for each row execute function reject_wallet_history_change();
    create trigger no_truncate_service_fulfilments before truncate on service_payment_fulfilments execute function reject_wallet_history_change();

    create or replace function grant_service_payments_runtime_access(runtime_role name) returns void language plpgsql as $$
    begin
      execute format('grant select on service_catalog_products, service_payment_quotes, service_payments, service_payment_outcomes, service_bill_account_validations, service_payment_fulfilments to %I', runtime_role);
      execute format('grant insert on service_payment_quotes, service_payments, service_payment_outcomes, service_bill_account_validations, service_payment_fulfilments to %I', runtime_role);
      execute format('grant update(id) on service_catalog_products, service_payment_quotes to %I', runtime_role);
      execute format('grant update(submission_started_at) on service_payments to %I', runtime_role);
    end $$;
  `.execute(database);
}
