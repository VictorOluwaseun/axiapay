/** Persist bounded recovery intent atomically with service-payment holds, including existing unresolved holds. No financial outcome or submission claim is changed. */
import { sql } from 'kysely';

/** Install a recovery outbox, fenced worker leases and restricted runtime access without touching ledger history. */
export async function up(database) {
  await sql`
    create table service_payment_recovery (
      payment_id uuid primary key references service_payments(id),
      recovery_status text not null default 'pending' check (recovery_status in ('pending', 'completed', 'needs_review')),
      automatic_attempts integer not null default 0 check (automatic_attempts >= 0),
      total_attempts integer not null default 0 check (total_attempts >= automatic_attempts),
      next_attempt_at timestamptz not null default now() + interval '30 seconds',
      lease_token uuid,
      lease_expires_at timestamptz,
      last_failure_code text check (last_failure_code ~ '^[A-Z][A-Z0-9_]{0,99}$'),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      check ((lease_token is null) = (lease_expires_at is null)),
      check (recovery_status = 'pending' or lease_token is null)
    );
    create index service_payment_recovery_due on service_payment_recovery(next_attempt_at, payment_id)
      where recovery_status = 'pending';

    create function schedule_service_payment_recovery() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public as $$
    begin
      insert into public.service_payment_recovery(payment_id)
        select payment.id from public.service_payments payment
        join public.service_payment_quotes quote on quote.id = payment.quote_id
        where payment.id::text = new.payment_reference and quote.wallet_id = new.wallet_id
          and quote.currency = new.currency and quote.total_debit_minor_units = new.amount_minor_units
          and new.reservation_status = 'reserved'
        on conflict (payment_id) do nothing;
      return new;
    end $$;
    revoke all on function schedule_service_payment_recovery() from public;
    create trigger schedule_service_payment_recovery after insert on wallet_reservations
      for each row execute function schedule_service_payment_recovery();

    insert into service_payment_recovery(payment_id)
      select payment.id from service_payments payment
      join service_payment_quotes quote on quote.id = payment.quote_id
      join wallet_reservations reservation on reservation.payment_reference = payment.id::text
        and reservation.wallet_id = quote.wallet_id and reservation.currency = quote.currency
        and reservation.amount_minor_units = quote.total_debit_minor_units
      where reservation.reservation_status = 'reserved'
      on conflict (payment_id) do nothing;

    create function grant_payment_recovery_runtime_access(runtime_role name) returns void language plpgsql as $$
    begin
      execute format('grant select, update on public.service_payment_recovery to %I', runtime_role);
    end $$;
    revoke all on function grant_payment_recovery_runtime_access(name) from public;
    comment on table service_payment_recovery is 'Durable service-payment follow-up; a queue wake-up never authorizes spending or releases an uncertain hold.';
  `.execute(database);
}

/** Recovery history is operational evidence; removal requires a reviewed forward migration. */
export async function down() {
  throw new Error('Payment recovery history has no automatic rollback.');
}
