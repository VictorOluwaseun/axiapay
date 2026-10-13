/** Add first-party domestic bank profiles, verified beneficiaries and atomic recipient-credit evidence; preserve existing service identities and balances. */
import { sql } from 'kysely';

/** Install bank transfer contracts without publishing a bank, setting commercial defaults, connecting an adapter or moving money. */
export async function up(database) {
  await sql`
    create table bank_transfer_banks (
      id uuid primary key, bank_code text not null check(bank_code ~ '^[a-z0-9][a-z0-9-]{0,49}$'),
      display_name text not null check(length(btrim(display_name)) between 1 and 200),
      country_code text not null check(country_code ~ '^[A-Z]{2}$'), currency text not null check(currency ~ '^[A-Z]{3}$'),
      minimum_account_number_length integer not null check(minimum_account_number_length between 1 and 34),
      maximum_account_number_length integer not null check(maximum_account_number_length between minimum_account_number_length and 34),
      is_enabled boolean not null default false, created_at timestamptz not null default now()
    );
    create unique index bank_transfer_one_enabled_profile on bank_transfer_banks(bank_code, country_code, currency) where is_enabled;
    -- Changing bank/account rules requires a new immutable revision; withdrawal remains possible without altering accepted recipients.
    create function guard_bank_profile() returns trigger language plpgsql as $$
    begin
      if (to_jsonb(new) - 'is_enabled') is distinct from (to_jsonb(old) - 'is_enabled') then raise exception 'bank profiles are immutable' using errcode = '23514'; end if;
      return new;
    end $$;
    create trigger protect_bank_profile before update on bank_transfer_banks for each row execute function guard_bank_profile();
    create trigger no_delete_bank_profiles before delete on bank_transfer_banks for each row execute function reject_wallet_history_change();
    create trigger no_truncate_bank_profiles before truncate on bank_transfer_banks execute function reject_wallet_history_change();

    alter table service_catalog_products drop constraint service_catalog_category, drop constraint service_catalog_recipient_kind, drop constraint service_catalog_price_kind,
      add column bank_id uuid references bank_transfer_banks(id), add column bank_beneficiary_validation_lifetime_seconds integer;
    alter table service_catalog_products add constraint service_catalog_category check(service_type in ('airtime', 'data', 'tv', 'electricity', 'education', 'insurance', 'bank_transfer')),
      add constraint service_catalog_recipient_kind check (
        ((service_type in ('airtime', 'data') and network_code is not null and biller_code is null)
          or (service_type in ('tv', 'electricity', 'education', 'insurance') and network_code is null and biller_code is not null and biller_code ~ '^[a-z0-9][a-z0-9-]{0,49}$')
          or (service_type = 'bank_transfer' and network_code is null and biller_code is null))
        and ((service_type = 'bank_transfer' and bank_id is not null and bank_beneficiary_validation_lifetime_seconds is not null and bank_beneficiary_validation_lifetime_seconds between 1 and 3600)
          or (service_type <> 'bank_transfer' and bank_id is null and bank_beneficiary_validation_lifetime_seconds is null))
        and ((service_type in ('tv', 'electricity') and account_validation_lifetime_seconds is not null and account_validation_lifetime_seconds between 1 and 3600)
          or (service_type not in ('tv', 'electricity') and account_validation_lifetime_seconds is null))
        and ((service_type = 'electricity' and electricity_meter_type is not null and electricity_meter_type in ('prepaid', 'postpaid'))
          or (service_type <> 'electricity' and electricity_meter_type is null))
        and ((service_type = 'education' and education_payment_type is not null and education_payment_type in ('institution_fee', 'voucher')
          and education_purpose is not null and length(btrim(education_purpose)) between 1 and 200 and education_validation_lifetime_seconds is not null and education_validation_lifetime_seconds between 1 and 3600)
          or (service_type <> 'education' and education_payment_type is null and education_purpose is null and education_validation_lifetime_seconds is null))
        and ((service_type = 'insurance' and insurance_terms is not null and valid_insurance_product_terms(insurance_terms) and insurance_application_lifetime_seconds is not null and insurance_application_lifetime_seconds between 1 and 3600)
          or (service_type <> 'insurance' and insurance_terms is null and insurance_application_lifetime_seconds is null))
      ),
      add constraint service_catalog_price_kind check (
        (service_type in ('airtime', 'electricity', 'bank_transfer') and fixed_price_minor_units is null and allowance_label is null and validity_seconds is null)
        or (service_type = 'data' and fixed_price_minor_units is not null and fixed_price_minor_units = minimum_amount_minor_units and fixed_price_minor_units = maximum_amount_minor_units
          and allowance_label is not null and length(allowance_label) between 1 and 200 and validity_seconds is not null and validity_seconds > 0)
        or (service_type = 'tv' and fixed_price_minor_units is not null and fixed_price_minor_units = minimum_amount_minor_units and fixed_price_minor_units = maximum_amount_minor_units and allowance_label is null and (validity_seconds is null or validity_seconds > 0))
        or (service_type = 'education' and allowance_label is null and validity_seconds is null and ((education_payment_type = 'institution_fee' and fixed_price_minor_units is null)
          or (fixed_price_minor_units is not null and fixed_price_minor_units = minimum_amount_minor_units and fixed_price_minor_units = maximum_amount_minor_units)))
        or (service_type = 'insurance' and fixed_price_minor_units is not null and fixed_price_minor_units = minimum_amount_minor_units and fixed_price_minor_units = maximum_amount_minor_units and allowance_label is null and validity_seconds is null)
      );
    -- Enforce the currency binding and publication prerequisite, while leaving limits/fees as immutable operator-defined terms.
    create function guard_bank_transfer_product() returns trigger language plpgsql as $$
    declare bank bank_transfer_banks%rowtype;
    begin
      if new.service_type <> 'bank_transfer' then return new; end if;
      select * into strict bank from bank_transfer_banks where id = new.bank_id for share;
      if new.currency <> bank.currency or (new.is_enabled and not bank.is_enabled) then raise exception 'invalid bank transfer product binding' using errcode = '23514'; end if;
      return new;
    end $$;
    create trigger protect_bank_transfer_product before insert or update on service_catalog_products for each row execute function guard_bank_transfer_product();

    create table bank_transfer_beneficiary_validations (
      id uuid primary key, owner_id text not null, product_id uuid not null references service_catalog_products(id), bank_id uuid not null references bank_transfer_banks(id),
      account_number text not null check(account_number ~ '^[0-9]{1,34}$'), account_name text not null check(length(btrim(account_name)) between 1 and 200),
      evidence_reference text not null check(length(evidence_reference) between 1 and 200), verified_at timestamptz not null,
      expires_at timestamptz not null check(expires_at > verified_at), unique(id, owner_id, product_id)
    );
    -- Persist only correctly bound snapshots; application verification authenticates the actual name enquiry before insertion.
    create function guard_bank_beneficiary() returns trigger language plpgsql as $$
    declare product service_catalog_products%rowtype; bank bank_transfer_banks%rowtype;
    begin
      select * into strict product from service_catalog_products where id = new.product_id for share;
      select * into strict bank from bank_transfer_banks where id = new.bank_id for share;
      if not product.is_enabled or product.service_type <> 'bank_transfer' or product.bank_id <> new.bank_id or not bank.is_enabled
        or length(new.account_number) not between bank.minimum_account_number_length and bank.maximum_account_number_length
        or new.expires_at <> new.verified_at + make_interval(secs => product.bank_beneficiary_validation_lifetime_seconds) then raise exception 'invalid bank beneficiary binding' using errcode = '23514'; end if;
      return new;
    end $$;
    create trigger protect_bank_beneficiary before insert on bank_transfer_beneficiary_validations for each row execute function guard_bank_beneficiary();
    create trigger immutable_bank_beneficiaries before update or delete on bank_transfer_beneficiary_validations for each row execute function reject_wallet_history_change();
    create trigger no_truncate_bank_beneficiaries before truncate on bank_transfer_beneficiary_validations execute function reject_wallet_history_change();

    alter table service_payment_quotes drop constraint service_quote_recipient_kind, add column bank_beneficiary_validation_id uuid, add column narration text,
      add constraint service_quote_bank_beneficiary foreign key(bank_beneficiary_validation_id, owner_id, product_id) references bank_transfer_beneficiary_validations(id, owner_id, product_id),
      add constraint service_quote_recipient_kind check(num_nonnulls(recipient_phone_number, account_validation_id, education_validation_id, insurance_application_id, bank_beneficiary_validation_id) = 1),
      add constraint service_quote_narration check(narration is null or (bank_beneficiary_validation_id is not null and length(btrim(narration)) between 1 and 140));
    -- Bound quote lifetime to verified recipient evidence and preserve all previously supported category bindings.
    create or replace function guard_service_quote() returns trigger language plpgsql as $$
    declare product service_catalog_products%rowtype; bound_expiry timestamptz; expected_expiry timestamptz;
    begin
      select * into strict product from service_catalog_products where id = new.product_id for share;
      expected_expiry := new.created_at + make_interval(secs => product.quote_lifetime_seconds);
      if product.service_type in ('airtime', 'data') and new.recipient_phone_number is null then raise exception 'mobile recipient required' using errcode = '23514'; end if;
      if product.service_type in ('tv', 'electricity') then select expires_at into strict bound_expiry from service_bill_account_validations where id = new.account_validation_id and owner_id = new.owner_id and product_id = new.product_id; end if;
      if product.service_type = 'education' then select expires_at into strict bound_expiry from service_education_validations where id = new.education_validation_id and owner_id = new.owner_id and product_id = new.product_id; end if;
      if product.service_type = 'insurance' then select expires_at into strict bound_expiry from service_insurance_applications where id = new.insurance_application_id and owner_id = new.owner_id and product_id = new.product_id; end if;
      if product.service_type = 'bank_transfer' then select expires_at into strict bound_expiry from bank_transfer_beneficiary_validations where id = new.bank_beneficiary_validation_id and owner_id = new.owner_id and product_id = new.product_id; end if;
      expected_expiry := least(expected_expiry, bound_expiry);
      if not product.is_enabled or new.currency <> product.currency or new.fee_minor_units <> product.fee_minor_units
        or new.principal_minor_units < product.minimum_amount_minor_units or new.principal_minor_units > product.maximum_amount_minor_units
        or mod(new.principal_minor_units - product.minimum_amount_minor_units, product.amount_step_minor_units) <> 0
        or new.expires_at <> expected_expiry or not exists(select 1 from wallets where id = new.wallet_id and owner_id = new.owner_id)
        or (product.service_type = 'bank_transfer' and not exists(select 1 from bank_transfer_banks where id = product.bank_id and is_enabled)) then raise exception 'invalid review terms' using errcode = '23514'; end if;
      return new;
    end $$;
    alter table service_payment_outcomes add column failure_reason text,
      add constraint service_outcome_failure_reason check(failure_reason is null or (outcome = 'failed' and failure_reason in ('bank_rejected', 'recipient_unavailable', 'account_restricted', 'transfer_not_completed')));
    -- Bank credit proof is append-only and service-specific, like existing receipts; application code validates its exact typed content first.
    create or replace function guard_service_fulfilment() returns trigger language plpgsql as $$
    begin
      if not exists (select 1 from service_payment_outcomes outcome join service_payments payment on payment.id = outcome.payment_id
        join service_payment_quotes quote on quote.id = payment.quote_id join service_catalog_products product on product.id = quote.product_id
        where payment.id = new.payment_id and outcome.outcome = 'succeeded' and (
          (product.service_type = 'tv' and new.fulfilment->>'fulfilmentType' = 'tv_subscription')
          or (product.service_type = 'electricity' and new.fulfilment->>'fulfilmentType' = 'electricity_' || product.electricity_meter_type)
          or (product.service_type = 'education' and new.fulfilment->>'fulfilmentType' = case product.education_payment_type when 'voucher' then 'education_voucher' else 'education_fee' end)
          or (product.service_type = 'insurance' and new.fulfilment->>'fulfilmentType' = 'insurance_policy')
          or (product.service_type = 'bank_transfer' and new.fulfilment->>'fulfilmentType' = 'bank_transfer')
        )) then raise exception 'fulfilment requires matching successful service payment' using errcode = '23514'; end if;
      return new;
    end $$;
    -- Defer until commit so authenticated bank success and its mandatory recipient-credit proof can be inserted together, never partially visible.
    create function require_bank_transfer_credit_proof() returns trigger language plpgsql as $$
    declare category text; matches_credit boolean;
    begin
      select product.service_type into strict category from service_payments payment join service_payment_quotes quote on quote.id = payment.quote_id
        join service_catalog_products product on product.id = quote.product_id where payment.id = new.payment_id;
      if category <> 'bank_transfer' then return new; end if;
      if new.outcome = 'failed' and new.failure_reason is null then raise exception 'bank failure requires safe reason' using errcode = '23514'; end if;
      if new.outcome <> 'succeeded' then return new; end if;
      select exists(select 1 from service_payments payment join service_payment_quotes quote on quote.id = payment.quote_id
        join bank_transfer_beneficiary_validations beneficiary on beneficiary.id = quote.bank_beneficiary_validation_id
        join service_payment_fulfilments receipt on receipt.payment_id = payment.id where payment.id = new.payment_id
        and receipt.fulfilment->>'fulfilmentType' = 'bank_transfer' and receipt.fulfilment->>'bankId' = beneficiary.bank_id::text
        and receipt.fulfilment->>'accountNumber' = beneficiary.account_number and receipt.fulfilment->>'accountName' = beneficiary.account_name
        and receipt.fulfilment->>'currency' = quote.currency and receipt.fulfilment->>'amountMinorUnits' = quote.principal_minor_units::text
        and length(btrim(receipt.fulfilment->>'transferReference')) between 1 and 200
        and receipt.fulfilment->>'creditedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$') into matches_credit;
      if not matches_credit then raise exception 'bank success requires matching recipient credit proof' using errcode = '23514'; end if;
      return new;
    end $$;
    create constraint trigger bank_transfer_credit_proof after insert on service_payment_outcomes deferrable initially deferred for each row execute function require_bank_transfer_credit_proof();
    -- Extend restricted runtime access; publication and all history mutation remain administrator-only.
    create or replace function grant_service_payments_runtime_access(runtime_role name) returns void language plpgsql as $$
    begin
      execute format('grant select on service_catalog_products, service_payment_quotes, service_payments, service_payment_outcomes, service_bill_account_validations, service_payment_fulfilments, service_education_validations, service_insurance_applications, service_payment_documents, bank_transfer_banks, bank_transfer_beneficiary_validations to %I', runtime_role);
      execute format('grant insert on service_payment_quotes, service_payments, service_payment_outcomes, service_bill_account_validations, service_payment_fulfilments, service_education_validations, service_insurance_applications, service_payment_documents, bank_transfer_beneficiary_validations to %I', runtime_role);
      execute format('grant update(id) on service_catalog_products, service_payment_quotes, bank_transfer_banks to %I', runtime_role);
      execute format('grant update(submission_started_at) on service_payments to %I', runtime_role);
    end $$;
  `.execute(database);
}
