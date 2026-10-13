/** Add education recipient evidence, consented insurance eligibility and private issued-document descriptors without changing existing payment identities. */
import { sql } from 'kysely';

/** Extend immutable catalogue/quote bindings for individual education and fixed-premium insurance; enable no products or adapters. */
export async function up(database) {
  await sql`
    alter table service_catalog_products drop constraint service_catalog_category,
      drop constraint service_catalog_recipient_kind, drop constraint service_catalog_price_kind,
      add column education_payment_type text,
      add column education_purpose text,
      add column education_validation_lifetime_seconds integer,
      add column insurance_terms jsonb,
      add column insurance_application_lifetime_seconds integer;

    -- Validate the bounded operator-owned terms shape before an immutable insurance revision can be published.
    create function valid_insurance_product_terms(terms jsonb) returns boolean language plpgsql immutable as $$
    declare field_value text;
    begin
      if jsonb_typeof(terms) is distinct from 'object' then return false; end if;
      if not terms ?& array['version', 'coverageSummary', 'exclusions', 'coverageDurationDays', 'cancellationRefundTerms', 'requiredInsuredFields', 'optionalInsuredFields'] then return false; end if;
      if jsonb_typeof(terms->'version') is distinct from 'string' or length(btrim(terms->>'version')) not between 1 and 100
        or jsonb_typeof(terms->'coverageSummary') is distinct from 'string' or length(btrim(terms->>'coverageSummary')) not between 1 and 2000
        or jsonb_typeof(terms->'cancellationRefundTerms') is distinct from 'string' or length(btrim(terms->>'cancellationRefundTerms')) not between 1 and 2000 then return false; end if;
      if jsonb_typeof(terms->'coverageDurationDays') is distinct from 'number' or (terms->>'coverageDurationDays') !~ '^[1-9][0-9]{0,4}$' then return false; end if;
      if (terms->>'coverageDurationDays')::integer > 36500 then return false; end if;
      if jsonb_typeof(terms->'exclusions') is distinct from 'array' or jsonb_typeof(terms->'requiredInsuredFields') is distinct from 'array'
        or jsonb_typeof(terms->'optionalInsuredFields') is distinct from 'array' then return false; end if;
      if jsonb_array_length(terms->'exclusions') > 30 or not (terms->'requiredInsuredFields') ? 'fullName' then return false; end if;
      if (select count(*) from jsonb_array_elements_text((terms->'requiredInsuredFields') || (terms->'optionalInsuredFields')))
        <> (select count(distinct value) from jsonb_array_elements_text((terms->'requiredInsuredFields') || (terms->'optionalInsuredFields'))) then return false; end if;
      for field_value in select value from jsonb_array_elements_text((terms->'requiredInsuredFields') || (terms->'optionalInsuredFields')) loop
        if field_value not in ('fullName', 'dateOfBirth', 'phoneNumber', 'email', 'address', 'identityNumber', 'assetReference') then return false; end if;
      end loop;
      if exists (select 1 from jsonb_array_elements(terms->'exclusions') value where jsonb_typeof(value) <> 'string'
        or length(btrim(value#>>'{}')) not between 1 and 1000) then return false; end if;
      return true;
    end $$;
    alter table service_catalog_products add constraint service_catalog_category check(service_type in ('airtime', 'data', 'tv', 'electricity', 'education', 'insurance')),
      add constraint service_catalog_recipient_kind check (
        ((service_type in ('airtime', 'data') and network_code is not null and biller_code is null)
          or (service_type in ('tv', 'electricity', 'education', 'insurance') and network_code is null and biller_code is not null
            and biller_code ~ '^[a-z0-9][a-z0-9-]{0,49}$'))
        and ((service_type in ('tv', 'electricity') and account_validation_lifetime_seconds is not null and account_validation_lifetime_seconds between 1 and 3600)
          or (service_type not in ('tv', 'electricity') and account_validation_lifetime_seconds is null))
        and ((service_type = 'electricity' and electricity_meter_type is not null and electricity_meter_type in ('prepaid', 'postpaid'))
          or (service_type <> 'electricity' and electricity_meter_type is null))
        and ((service_type = 'education' and education_payment_type is not null and education_payment_type in ('institution_fee', 'voucher')
          and education_purpose is not null and length(btrim(education_purpose)) between 1 and 200 and education_validation_lifetime_seconds is not null
          and education_validation_lifetime_seconds between 1 and 3600)
          or (service_type <> 'education' and education_payment_type is null and education_purpose is null and education_validation_lifetime_seconds is null))
        and ((service_type = 'insurance' and insurance_terms is not null and valid_insurance_product_terms(insurance_terms)
          and insurance_application_lifetime_seconds is not null and insurance_application_lifetime_seconds between 1 and 3600)
          or (service_type <> 'insurance' and insurance_terms is null and insurance_application_lifetime_seconds is null))
      ),
      add constraint service_catalog_price_kind check (
        (service_type in ('airtime', 'electricity') and fixed_price_minor_units is null and allowance_label is null and validity_seconds is null)
        or (service_type = 'data' and fixed_price_minor_units is not null and fixed_price_minor_units = minimum_amount_minor_units
          and fixed_price_minor_units = maximum_amount_minor_units and allowance_label is not null and length(allowance_label) between 1 and 200
          and validity_seconds is not null and validity_seconds > 0)
        or (service_type = 'tv' and fixed_price_minor_units is not null and fixed_price_minor_units = minimum_amount_minor_units
          and fixed_price_minor_units = maximum_amount_minor_units and allowance_label is null and (validity_seconds is null or validity_seconds > 0))
        or (service_type = 'education' and allowance_label is null and validity_seconds is null and (
          (education_payment_type = 'institution_fee' and fixed_price_minor_units is null)
          or (fixed_price_minor_units is not null and fixed_price_minor_units = minimum_amount_minor_units and fixed_price_minor_units = maximum_amount_minor_units)))
        or (service_type = 'insurance' and fixed_price_minor_units is not null and fixed_price_minor_units = minimum_amount_minor_units
          and fixed_price_minor_units = maximum_amount_minor_units and allowance_label is null and validity_seconds is null)
      );

    create table service_education_validations (
      id uuid primary key, owner_id text not null, product_id uuid not null references service_catalog_products(id),
      beneficiary_identifier text not null check(length(beneficiary_identifier) between 1 and 100 and beneficiary_identifier = btrim(beneficiary_identifier)),
      beneficiary_name text not null check(length(btrim(beneficiary_name)) between 1 and 200),
      evidence_reference text not null check(length(evidence_reference) between 1 and 200),
      verified_at timestamptz not null, expires_at timestamptz not null check(expires_at > verified_at), unique(id, owner_id, product_id)
    );
    create table service_insurance_applications (
      id uuid primary key, owner_id text not null, product_id uuid not null references service_catalog_products(id),
      insured_profile jsonb not null check(jsonb_typeof(insured_profile) = 'object'),
      terms_version text not null check(length(terms_version) between 1 and 100),
      accepted_terms boolean not null check(accepted_terms),
      coverage_starts_on date not null, coverage_ends_on date not null check(coverage_ends_on > coverage_starts_on),
      evidence_reference text not null check(length(evidence_reference) between 1 and 200),
      created_at timestamptz not null, expires_at timestamptz not null check(expires_at > created_at), unique(id, owner_id, product_id)
    );
    -- Bind authenticated beneficiary evidence to the enabled education revision and its configured lifetime.
    create function guard_education_validation() returns trigger language plpgsql as $$
    declare product service_catalog_products%rowtype;
    begin
      select * into strict product from service_catalog_products where id = new.product_id for share;
      if not product.is_enabled or product.service_type <> 'education' or new.expires_at <> new.verified_at + make_interval(secs => product.education_validation_lifetime_seconds) then
        raise exception 'invalid education validation binding' using errcode = '23514';
      end if;
      return new;
    end $$;
    create trigger protect_education_validation before insert on service_education_validations for each row execute function guard_education_validation();
    -- Bind consented eligibility evidence to the reviewed revision, derived requested period and evidence lifetime.
    create function guard_insurance_application() returns trigger language plpgsql as $$
    declare product service_catalog_products%rowtype;
    begin
      select * into strict product from service_catalog_products where id = new.product_id for share;
      if not product.is_enabled or product.service_type <> 'insurance' or new.terms_version <> product.insurance_terms->>'version'
        or new.coverage_ends_on <> new.coverage_starts_on + (product.insurance_terms->>'coverageDurationDays')::integer
        or new.expires_at <> new.created_at + make_interval(secs => product.insurance_application_lifetime_seconds) then
        raise exception 'invalid insurance application binding' using errcode = '23514';
      end if;
      return new;
    end $$;
    create trigger protect_insurance_application before insert on service_insurance_applications for each row execute function guard_insurance_application();
    create trigger immutable_education_validations before update or delete on service_education_validations for each row execute function reject_wallet_history_change();
    create trigger immutable_insurance_applications before update or delete on service_insurance_applications for each row execute function reject_wallet_history_change();
    create trigger no_truncate_education_validations before truncate on service_education_validations execute function reject_wallet_history_change();
    create trigger no_truncate_insurance_applications before truncate on service_insurance_applications execute function reject_wallet_history_change();

    alter table service_payment_quotes drop constraint service_quote_recipient_kind,
      add column education_validation_id uuid, add column insurance_application_id uuid,
      add constraint service_quote_education_recipient foreign key(education_validation_id, owner_id, product_id) references service_education_validations(id, owner_id, product_id),
      add constraint service_quote_insurance_application foreign key(insurance_application_id, owner_id, product_id) references service_insurance_applications(id, owner_id, product_id),
      add constraint service_quote_recipient_kind check(num_nonnulls(recipient_phone_number, account_validation_id, education_validation_id, insurance_application_id) = 1);
    alter table service_payments add column insurance_application_id uuid references service_insurance_applications(id),
      add constraint service_payment_one_insurance_application unique(insurance_application_id);
    -- Derive the unique application binding from locked immutable quote history, never a caller-supplied application override.
    create function bind_insurance_payment_application() returns trigger language plpgsql as $$
    begin
      select insurance_application_id into new.insurance_application_id from service_payment_quotes where id = new.quote_id;
      return new;
    end $$;
    create trigger bind_insurance_payment before insert on service_payments for each row execute function bind_insurance_payment_application();
    -- Require owner/product-specific preparation and authoritative money terms, preserving existing mobile and bill quote lifetimes.
    create or replace function guard_service_quote() returns trigger language plpgsql as $$
    declare product service_catalog_products%rowtype; bound_expiry timestamptz; expected_expiry timestamptz;
    begin
      select * into strict product from service_catalog_products where id = new.product_id for share;
      expected_expiry := new.created_at + make_interval(secs => product.quote_lifetime_seconds);
      if product.service_type in ('airtime', 'data') and new.recipient_phone_number is null then raise exception 'mobile recipient required' using errcode = '23514'; end if;
      if product.service_type in ('tv', 'electricity') then
        select expires_at into strict bound_expiry from service_bill_account_validations where id = new.account_validation_id and owner_id = new.owner_id and product_id = new.product_id;
      end if;
      if product.service_type = 'education' then
        select expires_at into strict bound_expiry from service_education_validations where id = new.education_validation_id and owner_id = new.owner_id and product_id = new.product_id;
      end if;
      if product.service_type = 'insurance' then
        select expires_at into strict bound_expiry from service_insurance_applications where id = new.insurance_application_id and owner_id = new.owner_id and product_id = new.product_id;
      end if;
      expected_expiry := least(expected_expiry, bound_expiry);
      if not product.is_enabled or new.currency <> product.currency or new.fee_minor_units <> product.fee_minor_units
        or new.principal_minor_units < product.minimum_amount_minor_units or new.principal_minor_units > product.maximum_amount_minor_units
        or mod(new.principal_minor_units - product.minimum_amount_minor_units, product.amount_step_minor_units) <> 0
        or new.expires_at <> expected_expiry or not exists(select 1 from wallets where id = new.wallet_id and owner_id = new.owner_id) then
        raise exception 'invalid review terms' using errcode = '23514';
      end if;
      return new;
    end $$;
    -- Append service-appropriate proof only after a correlated successful financial observation; services validate the typed proof contents.
    create or replace function guard_service_fulfilment() returns trigger language plpgsql as $$
    begin
      if not exists (select 1 from service_payment_outcomes outcome join service_payments payment on payment.id = outcome.payment_id
        join service_payment_quotes quote on quote.id = payment.quote_id join service_catalog_products product on product.id = quote.product_id
        where payment.id = new.payment_id and outcome.outcome = 'succeeded' and (
          (product.service_type = 'tv' and new.fulfilment->>'fulfilmentType' = 'tv_subscription')
          or (product.service_type = 'electricity' and new.fulfilment->>'fulfilmentType' = 'electricity_' || product.electricity_meter_type)
          or (product.service_type = 'education' and new.fulfilment->>'fulfilmentType' = case product.education_payment_type when 'voucher' then 'education_voucher' else 'education_fee' end)
          or (product.service_type = 'insurance' and new.fulfilment->>'fulfilmentType' = 'insurance_policy')
        )) then raise exception 'fulfilment requires matching successful service payment' using errcode = '23514'; end if;
      return new;
    end $$;

    create table service_payment_documents (
      payment_id uuid not null references service_payment_outcomes(payment_id), document_id text not null check(document_id ~ '^[a-z0-9][a-z0-9-]{0,49}$'),
      document_type text not null check(document_type in ('education_receipt', 'policy', 'certificate')),
      display_name text not null check(length(display_name) between 1 and 200), content_type text not null check(content_type = 'application/pdf'),
      provider_document_reference text not null check(length(provider_document_reference) between 1 and 200),
      recorded_at timestamptz not null default now(), primary key(payment_id, document_id)
    );
    -- Keep private descriptors service appropriate and require actual policy issuance before insurance document persistence.
    create function guard_payment_document() returns trigger language plpgsql as $$
    begin
      if not exists (select 1 from service_payment_outcomes outcome join service_payments payment on payment.id = outcome.payment_id
        join service_payment_quotes quote on quote.id = payment.quote_id join service_catalog_products product on product.id = quote.product_id
        left join service_payment_fulfilments receipt on receipt.payment_id = payment.id
        where payment.id = new.payment_id and outcome.outcome = 'succeeded' and (
          (product.service_type = 'education' and new.document_type = 'education_receipt')
          or (product.service_type = 'insurance' and new.document_type in ('policy', 'certificate') and receipt.fulfilment->>'fulfilmentType' = 'insurance_policy')
        )) then raise exception 'document requires matching confirmed service evidence' using errcode = '23514'; end if;
      return new;
    end $$;
    create trigger protect_payment_document before insert on service_payment_documents for each row execute function guard_payment_document();
    create trigger immutable_payment_documents before update or delete on service_payment_documents for each row execute function reject_wallet_history_change();
    create trigger no_truncate_payment_documents before truncate on service_payment_documents execute function reject_wallet_history_change();
    -- Extend the deployment grant without exposing publication, repricing or history mutation to the runtime role.
    create or replace function grant_service_payments_runtime_access(runtime_role name) returns void language plpgsql as $$
    begin
      execute format('grant select on service_catalog_products, service_payment_quotes, service_payments, service_payment_outcomes, service_bill_account_validations, service_payment_fulfilments, service_education_validations, service_insurance_applications, service_payment_documents to %I', runtime_role);
      execute format('grant insert on service_payment_quotes, service_payments, service_payment_outcomes, service_bill_account_validations, service_payment_fulfilments, service_education_validations, service_insurance_applications, service_payment_documents to %I', runtime_role);
      execute format('grant update(id) on service_catalog_products, service_payment_quotes to %I', runtime_role);
      execute format('grant update(submission_started_at) on service_payments to %I', runtime_role);
    end $$;
  `.execute(database);
}
