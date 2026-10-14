/** Install inbound airtime conversion history without enabling networks, commercial terms, providers or wallet credit. */
import { sql } from 'kysely';

/** Preserve existing ledgers and features; conversion receipts and instructions are append-only, with narrowly granted runtime access. */
export async function up(database) {
  await sql`
    create table airtime_conversion_quotes (
      id uuid primary key, owner_id uuid not null references auth_accounts(id), wallet_id uuid not null references wallets(id),
      offer_id text not null, display_name text not null, network_code text not null, source_phone_number text not null check(source_phone_number ~ '^\\+[1-9][0-9]{7,14}$'),
      currency text not null check(currency ~ '^[A-Z]{3}$'), terms_version text not null,
      rate_numerator bigint not null check(rate_numerator > 0), rate_denominator bigint not null check(rate_denominator > 0),
      fixed_fee_minor_units bigint not null check(fixed_fee_minor_units >= 0), fee_basis_points integer not null check(fee_basis_points between 0 and 10000),
      minimum_airtime_minor_units bigint not null check(minimum_airtime_minor_units > 0), maximum_airtime_minor_units bigint not null,
      airtime_step_minor_units bigint not null check(airtime_step_minor_units > 0),
      quote_validity_seconds integer not null check(quote_validity_seconds between 1 and 86400), transfer_window_seconds integer not null check(transfer_window_seconds between 1 and 86400),
      airtime_minor_units bigint not null, gross_credit_minor_units bigint not null check(gross_credit_minor_units > 0),
      fee_minor_units bigint not null check(fee_minor_units >= 0), net_credit_minor_units bigint not null check(net_credit_minor_units > 0),
      provider_id text not null, partner_account_id uuid not null references ledger_accounts(id), provider_product_code text not null,
      eligibility_reference text not null, quoted_at timestamptz not null, expires_at timestamptz not null,
      unique(id, owner_id),
      check(maximum_airtime_minor_units >= minimum_airtime_minor_units),
      check(airtime_minor_units between minimum_airtime_minor_units and maximum_airtime_minor_units),
      check(mod(airtime_minor_units - minimum_airtime_minor_units, airtime_step_minor_units) = 0),
      check(gross_credit_minor_units = floor(airtime_minor_units::numeric * rate_numerator / rate_denominator)),
      check(fee_minor_units::numeric = fixed_fee_minor_units::numeric + ceil(gross_credit_minor_units::numeric * fee_basis_points / 10000)),
      check(net_credit_minor_units::numeric = gross_credit_minor_units::numeric - fee_minor_units),
      check(expires_at > quoted_at and expires_at <= quoted_at + quote_validity_seconds * interval '1 second')
    );
    create function guard_conversion_quote() returns trigger language plpgsql as $$
    begin
      if not exists(select 1 from wallets where id = new.wallet_id and owner_id = new.owner_id::text and currency = new.currency and wallet_status <> 'closed')
        or not exists(select 1 from ledger_accounts where id = new.partner_account_id and account_kind = 'partner_funds' and currency = new.currency) then
        raise exception 'invalid conversion destination or clearing account' using errcode = '23514';
      end if;
      return new;
    end $$;
    create trigger conversion_quote_binding before insert on airtime_conversion_quotes for each row execute function guard_conversion_quote();
    create trigger immutable_conversion_quotes before update or delete on airtime_conversion_quotes for each row execute function reject_wallet_history_change();

    create table airtime_conversions (
      id uuid primary key, owner_id uuid not null, quote_id uuid not null unique,
      request_key text not null check(length(request_key) between 1 and 200 and request_key = btrim(request_key)),
      request_fingerprint text not null, accepted_at timestamptz not null, receive_by timestamptz not null,
      initialization_started_at timestamptz,
      foreign key(quote_id, owner_id) references airtime_conversion_quotes(id, owner_id), unique(owner_id, request_key)
    );
    create function guard_conversion_acceptance() returns trigger language plpgsql as $$
    declare quote airtime_conversion_quotes%rowtype;
    begin
      select * into strict quote from airtime_conversion_quotes where id = new.quote_id;
      if new.accepted_at < quote.quoted_at or new.accepted_at >= quote.expires_at or new.receive_by <> new.accepted_at + quote.transfer_window_seconds * interval '1 second' then
        raise exception 'invalid conversion acceptance' using errcode = '23514';
      end if;
      return new;
    end $$;
    create trigger conversion_acceptance_binding before insert on airtime_conversions for each row execute function guard_conversion_acceptance();
    create function guard_conversion_preparation() returns trigger language plpgsql as $$
    begin
      if (to_jsonb(new) - 'initialization_started_at') is distinct from (to_jsonb(old) - 'initialization_started_at')
        or old.initialization_started_at is not null or new.initialization_started_at is null then
        raise exception 'conversion acceptance and preparation claim are immutable' using errcode = '23514';
      end if;
      return new;
    end $$;
    create trigger immutable_conversion_acceptance before update on airtime_conversions for each row execute function guard_conversion_preparation();
    create trigger no_delete_conversions before delete on airtime_conversions for each row execute function reject_wallet_history_change();

    create table airtime_conversion_instructions (
      conversion_id uuid primary key references airtime_conversions(id), instruction_reference text not null check(length(btrim(instruction_reference)) between 1 and 200),
      receiving_phone_number text not null check(receiving_phone_number ~ '^\\+[1-9][0-9]{7,14}$'),
      description text not null check(length(btrim(description)) between 1 and 1000), issued_at timestamptz not null,
      instructions_fingerprint text not null
    );
    create function guard_conversion_instructions() returns trigger language plpgsql as $$
    begin
      if not exists(select 1 from airtime_conversions where id = new.conversion_id and initialization_started_at is not null
        and new.issued_at between accepted_at and receive_by) then
        raise exception 'instructions require a claimed accepted conversion' using errcode = '23514';
      end if;
      return new;
    end $$;
    create trigger conversion_instruction_binding before insert on airtime_conversion_instructions for each row execute function guard_conversion_instructions();
    create trigger immutable_conversion_instructions before update or delete on airtime_conversion_instructions for each row execute function reject_wallet_history_change();

    create table airtime_conversion_outcomes (
      conversion_id uuid primary key references airtime_conversions(id), partner_account_id uuid not null references ledger_accounts(id),
      outcome text not null check(outcome in ('verified', 'exception')),
      exception_code text check(exception_code in ('amount_mismatch', 'late_receipt', 'terms_mismatch', 'verification_failed', 'movement_conflict')),
      external_movement_id text check(length(btrim(external_movement_id)) between 1 and 200),
      evidence_reference text not null check(length(btrim(evidence_reference)) between 1 and 200),
      received_at timestamptz, observed_airtime_minor_units bigint check(observed_airtime_minor_units > 0), observed_currency text,
      receipt_fingerprint text not null, receipt jsonb,
      unique(partner_account_id, external_movement_id),
      check((outcome = 'verified' and exception_code is null and external_movement_id is not null and received_at is not null and observed_airtime_minor_units is not null and observed_currency is not null and receipt is not null)
        or (outcome = 'exception' and exception_code is not null))
    );
    create function guard_conversion_outcome() returns trigger language plpgsql as $$
    declare request airtime_conversions%rowtype; quote airtime_conversion_quotes%rowtype; instructions airtime_conversion_instructions%rowtype;
    begin
      select * into strict request from airtime_conversions where id = new.conversion_id;
      select * into strict quote from airtime_conversion_quotes where id = request.quote_id;
      if new.partner_account_id <> quote.partner_account_id or request.initialization_started_at is null then raise exception 'invalid conversion evidence binding' using errcode = '23514'; end if;
      if new.outcome <> 'verified' then return new; end if;
      select * into strict instructions from airtime_conversion_instructions where conversion_id = new.conversion_id;
      if not coalesce(new.receipt->>'conversionId' = request.id::text and new.receipt->>'requestFingerprint' = request.request_fingerprint
        and new.receipt->>'externalMovementId' = new.external_movement_id and new.receipt->>'evidenceReference' = new.evidence_reference
        and new.receipt->>'sourcePhoneNumber' = quote.source_phone_number and new.receipt->>'networkCode' = quote.network_code
        and new.receipt->>'instructionReference' = instructions.instruction_reference and new.receipt->>'receivingPhoneNumber' = instructions.receiving_phone_number
        and new.receipt->'airtimeValue'->>'amountMinorUnits' = quote.airtime_minor_units::text and new.receipt->'airtimeValue'->>'currency' = quote.currency
        and new.receipt->'netCreditValue'->>'amountMinorUnits' = quote.net_credit_minor_units::text and new.receipt->'netCreditValue'->>'currency' = quote.currency
        and new.observed_airtime_minor_units = quote.airtime_minor_units and new.observed_currency = quote.currency
        and new.received_at between instructions.issued_at and request.receive_by and (new.receipt->>'receivedAt')::timestamptz = new.received_at, false) then
        raise exception 'verified receipt must match accepted conversion' using errcode = '23514';
      end if;
      return new;
    end $$;
    create trigger conversion_outcome_binding before insert on airtime_conversion_outcomes for each row execute function guard_conversion_outcome();
    create trigger immutable_conversion_outcomes before update or delete on airtime_conversion_outcomes for each row execute function reject_wallet_history_change();
    create function grant_airtime_conversion_runtime_access(runtime_role name) returns void language plpgsql as $$
    begin
      execute format('grant select, insert on airtime_conversion_quotes, airtime_conversions, airtime_conversion_instructions, airtime_conversion_outcomes to %I', runtime_role);
      execute format('grant update(id) on airtime_conversion_quotes to %I', runtime_role);
      execute format('grant update(initialization_started_at) on airtime_conversions to %I', runtime_role);
    end $$;
    revoke all on function grant_airtime_conversion_runtime_access(name) from public;
  `.execute(database);
}
