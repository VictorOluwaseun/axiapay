/** Extend provider-neutral service contracts with explicit delivery contacts, merchant recipients and voucher/insurance preparation requirements; never seed products or move funds. */
import { sql } from 'kysely';

/** Preserve legacy recipient rules and fingerprints while enabling new immutable product revisions and quote fields. */
export async function up(database) {
  await sql`
    alter table service_catalog_products add column education_recipient_verification_required boolean not null default true,
      add constraint service_education_delivery_kind check(education_recipient_verification_required or (service_type = 'education' and education_payment_type = 'voucher'));
    alter table service_payment_quotes
      add column contact_phone_number text check(contact_phone_number ~ '^[+][1-9][0-9]{7,14}$'),
      add column merchant_recipient_identifier text check(merchant_recipient_identifier ~ '^[ -~]{1,100}$' and btrim(merchant_recipient_identifier) = merchant_recipient_identifier),
      drop constraint service_quote_recipient_kind,
      add constraint service_quote_recipient_kind check(num_nonnulls(recipient_phone_number, account_validation_id, education_validation_id, insurance_application_id, bank_beneficiary_validation_id, merchant_recipient_identifier) = 1);
    create or replace function valid_insurance_product_terms(terms jsonb) returns boolean language plpgsql immutable as $$
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
        if field_value not in ('fullName', 'dateOfBirth', 'phoneNumber', 'email', 'address', 'identityNumber', 'assetReference', 'nextOfKinName', 'nextOfKinPhoneNumber', 'occupation', 'engineCapacityBand', 'chassisNumber', 'vehicleMake', 'vehicleModel', 'vehicleColour', 'manufactureYear', 'state', 'localGovernmentArea') then return false; end if;
      end loop;
      if exists (select 1 from jsonb_array_elements(terms->'exclusions') value where jsonb_typeof(value) <> 'string'
        or length(btrim(value#>>'{}')) not between 1 and 1000) then return false; end if;
      if terms ? 'eligibilityMode' and (jsonb_typeof(terms->'eligibilityMode') is distinct from 'string' or terms->>'eligibilityMode' not in ('provider_verified', 'submission_requirements')) then return false; end if;
      if terms ? 'coverageStartMode' and (jsonb_typeof(terms->'coverageStartMode') is distinct from 'string' or terms->>'coverageStartMode' not in ('requested', 'provider_assigned')) then return false; end if;
      return true;
    end $$;
    alter table service_catalog_products drop constraint service_catalog_category, drop constraint service_catalog_recipient_kind, drop constraint service_catalog_price_kind;
    alter table service_catalog_products add constraint service_catalog_category check(service_type in ('airtime', 'data', 'tv', 'electricity', 'education', 'insurance', 'bank_transfer', 'merchant')),
      add constraint service_catalog_recipient_kind check (
        ((service_type in ('airtime', 'data') and network_code is not null and biller_code is null)
          or (service_type in ('tv', 'electricity', 'education', 'insurance', 'merchant') and network_code is null and biller_code is not null and biller_code ~ '^[a-z0-9][a-z0-9-]{0,49}$')
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
        or (service_type = 'merchant' and allowance_label is null and validity_seconds is null and (fixed_price_minor_units is null or (fixed_price_minor_units = minimum_amount_minor_units and fixed_price_minor_units = maximum_amount_minor_units)))
        or (service_type = 'insurance' and fixed_price_minor_units is not null and fixed_price_minor_units = minimum_amount_minor_units and fixed_price_minor_units = maximum_amount_minor_units and allowance_label is null and validity_seconds is null)
      );
    create or replace function guard_service_quote() returns trigger language plpgsql as $$
    declare product service_catalog_products%rowtype; bound_expiry timestamptz; expected_expiry timestamptz;
    begin
      select * into strict product from service_catalog_products where id = new.product_id for share;
      expected_expiry := new.created_at + make_interval(secs => product.quote_lifetime_seconds);
      if product.service_type in ('airtime', 'data') and new.recipient_phone_number is null then raise exception 'mobile recipient required' using errcode = '23514'; end if;
      if product.service_type in ('tv', 'electricity') then select expires_at into strict bound_expiry from service_bill_account_validations where id = new.account_validation_id and owner_id = new.owner_id and product_id = new.product_id; end if;
      if product.service_type = 'merchant' and new.merchant_recipient_identifier is null then raise exception 'merchant recipient required' using errcode = '23514'; end if;
      if product.service_type <> 'merchant' and new.merchant_recipient_identifier is not null then raise exception 'unexpected merchant recipient' using errcode = '23514'; end if;
      if product.service_type = 'education' and not product.education_recipient_verification_required and new.recipient_phone_number is null then raise exception 'voucher delivery phone required' using errcode = '23514'; end if;
      if product.service_type = 'education' and product.education_recipient_verification_required then select expires_at into strict bound_expiry from service_education_validations where id = new.education_validation_id and owner_id = new.owner_id and product_id = new.product_id; end if;
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
  `.execute(database);
}

/** Accepted financial history requires a reviewed forward migration for removal. */
export async function down() {
  throw new Error('Service contract history has no automatic rollback.');
}
