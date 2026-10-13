/** Create the wallet subledger. Financial history has no automatic destructive rollback. */
import { sql } from 'kysely';

/** Install exact-money tables and database accounting protections in the migration transaction. */
export async function up(database) {
  await sql`
    create table wallets (
      id uuid primary key,
      owner_id text not null check (length(owner_id) between 1 and 200),
      currency text not null check (currency ~ '^[A-Z]{3}$'),
      wallet_status text not null default 'active' check (wallet_status in ('active', 'frozen', 'closed')),
      created_at timestamptz not null default now(),
      unique (owner_id, currency), unique (id, currency)
    );
    create table ledger_accounts (
      id uuid primary key,
      account_code text not null unique,
      currency text not null check (currency ~ '^[A-Z]{3}$'),
      account_kind text not null check (account_kind in ('wallet_available', 'wallet_reserved', 'partner_funds', 'fee_income')),
      wallet_id uuid,
      unique (id, currency), unique (wallet_id, account_kind),
      foreign key (wallet_id, currency) references wallets (id, currency),
      check ((wallet_id is not null) = (account_kind in ('wallet_available', 'wallet_reserved')))
    );
    create table ledger_balances (
      account_id uuid primary key references ledger_accounts (id),
      debits_minor_units bigint not null default 0 check (debits_minor_units >= 0),
      credits_minor_units bigint not null default 0 check (credits_minor_units >= 0),
      enforce_nonnegative boolean not null,
      balance_version bigint not null default 0,
      check (not enforce_nonnegative or credits_minor_units >= debits_minor_units)
    );
    create table wallet_operations (
      id uuid primary key,
      request_scope text not null,
      request_key text not null check (length(request_key) between 1 and 200),
      request_fingerprint text not null,
      created_at timestamptz not null default now(),
      unique (request_scope, request_key)
    );
    create table wallet_reservations (
      id uuid primary key references wallet_operations (id),
      wallet_id uuid not null,
      currency text not null,
      payment_reference text not null unique,
      amount_minor_units bigint not null check (amount_minor_units > 0),
      reservation_status text not null default 'reserved' check (reservation_status in ('reserved', 'captured', 'released')),
      created_at timestamptz not null default now(),
      foreign key (wallet_id, currency) references wallets (id, currency),
      unique (id, currency)
    );
    create table ledger_journals (
      id uuid primary key references wallet_operations (id),
      currency text not null,
      journal_kind text not null check (journal_kind in ('funding', 'transfer', 'reserve', 'capture', 'release')),
      reservation_id uuid,
      evidence_reference text,
      recorded_at timestamptz not null default now(),
      creation_transaction xid8 not null default pg_current_xact_id(),
      unique (id, currency),
      foreign key (reservation_id, currency) references wallet_reservations (id, currency),
      check ((reservation_id is not null) = (journal_kind in ('reserve', 'capture', 'release'))),
      check (journal_kind <> 'reserve' or id = reservation_id),
      check (journal_kind not in ('funding', 'capture', 'release') or (evidence_reference is not null and length(evidence_reference) > 0))
    );
    create unique index one_reservation_opening on ledger_journals (reservation_id) where journal_kind = 'reserve';
    create unique index one_reservation_resolution on ledger_journals (reservation_id) where journal_kind in ('capture', 'release');
    create table ledger_entries (
      journal_id uuid not null,
      line_number integer not null check (line_number > 0),
      account_id uuid not null,
      currency text not null,
      entry_side text not null check (entry_side in ('debit', 'credit')),
      amount_minor_units bigint not null check (amount_minor_units > 0),
      primary key (journal_id, line_number),
      foreign key (journal_id, currency) references ledger_journals (id, currency),
      foreign key (account_id, currency) references ledger_accounts (id, currency)
    );
    create index ledger_entries_account_history on ledger_entries (account_id, journal_id);
    create index wallet_reservations_outstanding on wallet_reservations (wallet_id) where reservation_status = 'reserved';
    create table wallet_outbox_events (
      id uuid primary key references ledger_journals (id),
      event_type text not null default 'wallet.journal-posted',
      created_at timestamptz not null default now(),
      delivered_at timestamptz,
      delivery_attempts integer not null default 0 check (delivery_attempts >= 0)
    );
    create index wallet_outbox_pending on wallet_outbox_events (created_at, id) where delivered_at is null;

    -- Immutable account identities prevent reclassifying old money or changing its owner/currency.
    create function reject_wallet_history_change() returns trigger language plpgsql as $$
    begin
      raise exception 'wallet history is immutable' using errcode = '23514';
    end $$;
    create trigger immutable_accounts before update or delete on ledger_accounts for each row execute function reject_wallet_history_change();
    create trigger immutable_operations before update or delete on wallet_operations for each row execute function reject_wallet_history_change();
    create trigger immutable_journals before update or delete on ledger_journals for each row execute function reject_wallet_history_change();
    create trigger immutable_entries before update or delete on ledger_entries for each row execute function reject_wallet_history_change();
    create trigger no_truncate_accounts before truncate on ledger_accounts execute function reject_wallet_history_change();
    create trigger no_truncate_operations before truncate on wallet_operations execute function reject_wallet_history_change();
    create trigger no_truncate_journals before truncate on ledger_journals execute function reject_wallet_history_change();
    create trigger no_truncate_entries before truncate on ledger_entries execute function reject_wallet_history_change();
    create trigger no_truncate_balances before truncate on ledger_balances execute function reject_wallet_history_change();

    -- Ownership/currency changes must never reinterpret previously posted money.
    create function guard_wallet_identity() returns trigger language plpgsql as $$
    begin
      if (new.id, new.owner_id, new.currency, new.created_at) is distinct from (old.id, old.owner_id, old.currency, old.created_at) then
        raise exception 'wallet identity is immutable' using errcode = '23514';
      end if;
      return new;
    end $$;
    create trigger immutable_wallet_identity before update on wallets for each row execute function guard_wallet_identity();
    create trigger no_delete_wallets before delete on wallets for each row execute function reject_wallet_history_change();
    create trigger no_truncate_wallets before truncate on wallets execute function reject_wallet_history_change();
    -- A committed wallet always has both liability accounts.
    create function validate_wallet_accounts() returns trigger language plpgsql as $$
    begin
      if (select count(*) from ledger_accounts where wallet_id = new.id) <> 2 then
        raise exception 'wallet must have available and reserved accounts' using errcode = '23514';
      end if;
      return null;
    end $$;
    create constraint trigger complete_wallet_accounts after insert on wallets deferrable initially deferred for each row execute function validate_wallet_accounts();

    -- The entry projection is the only writer of balances; runtime roles cannot repair balances by hand.
    create function guard_wallet_balance_write() returns trigger language plpgsql as $$
    begin
      if pg_trigger_depth() < 2 then
        raise exception 'balances can only change through ledger entries' using errcode = '23514';
      end if;
      return new;
    end $$;
    create trigger protected_balances before insert or update or delete on ledger_balances for each row execute function guard_wallet_balance_write();
    create function initialize_wallet_account_balance() returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
    begin
      insert into public.ledger_balances (account_id, enforce_nonnegative)
      values (new.id, new.account_kind in ('wallet_available', 'wallet_reserved'));
      return new;
    end $$;
    create trigger initialize_balance after insert on ledger_accounts for each row execute function initialize_wallet_account_balance();

    -- Never accept a caller-supplied transaction identity for reopening a committed journal.
    create function stamp_wallet_journal() returns trigger language plpgsql as $$
    begin
      new.creation_transaction := pg_current_xact_id();
      new.recorded_at := clock_timestamp();
      return new;
    end $$;
    create trigger stamp_journal before insert on ledger_journals for each row execute function stamp_wallet_journal();
    -- Project exact entry amounts and bind reserved movements to their allocation.
    create function project_wallet_entry() returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
    begin
      if not exists (select 1 from public.ledger_journals where id = new.journal_id and creation_transaction = pg_current_xact_id()) then
        raise exception 'cannot append to a committed journal' using errcode = '23514';
      end if;
      if exists (select 1 from public.ledger_accounts where id = new.account_id and account_kind = 'wallet_reserved')
        and not exists (
          select 1 from public.ledger_journals j
          join public.wallet_reservations r on r.id = j.reservation_id
          join public.ledger_accounts a on a.wallet_id = r.wallet_id and a.id = new.account_id
          where j.id = new.journal_id and
            ((j.journal_kind = 'reserve' and new.entry_side = 'credit') or
             (j.journal_kind in ('capture', 'release') and new.entry_side = 'debit'))
        ) then
        raise exception 'reserved entry must belong to its payment allocation' using errcode = '23514';
      end if;
      update public.ledger_balances set
        debits_minor_units = debits_minor_units + case when new.entry_side = 'debit' then new.amount_minor_units else 0 end,
        credits_minor_units = credits_minor_units + case when new.entry_side = 'credit' then new.amount_minor_units else 0 end,
        balance_version = balance_version + 1
      where account_id = new.account_id;
      if not found then
        raise exception 'ledger account does not exist' using errcode = '23503';
      end if;
      return new;
    end $$;
    create trigger project_entry after insert on ledger_entries for each row execute function project_wallet_entry();

    -- Validate at commit, including empty headers and entries added after SET CONSTRAINTS.
    create function validate_wallet_journal() returns trigger language plpgsql as $$
    declare target_id uuid; line_count bigint; signed_total numeric;
    begin
      target_id := (to_jsonb(new) ->> tg_argv[0])::uuid;
      select count(*), coalesce(sum(case when entry_side = 'debit' then amount_minor_units::numeric else -amount_minor_units::numeric end), 0)
      into line_count, signed_total from ledger_entries where journal_id = target_id;
      if line_count < 2 or signed_total <> 0 then
        raise exception 'journal must contain balanced entries' using errcode = '23514';
      end if;
      return null;
    end $$;
    create constraint trigger balanced_journal after insert on ledger_journals deferrable initially deferred for each row execute function validate_wallet_journal('id');
    create constraint trigger balanced_entry after insert on ledger_entries deferrable initially deferred for each row execute function validate_wallet_journal('journal_id');

    -- A successful idempotency claim must have a complete journal and durable notification.
    create function validate_wallet_operation() returns trigger language plpgsql as $$
    begin
      if not exists (select 1 from ledger_journals j join wallet_outbox_events e on e.id = j.id where j.id = new.id) then
        raise exception 'wallet operation requires a journal and outbox event' using errcode = '23514';
      end if;
      return null;
    end $$;
    create constraint trigger complete_wallet_operation after insert on wallet_operations deferrable initially deferred for each row execute function validate_wallet_operation();

    -- A reservation's immutable identity and amount survive resolution and retries.
    create function guard_wallet_reservation() returns trigger language plpgsql as $$
    begin
      if tg_op = 'DELETE' then raise exception 'reservations cannot be deleted' using errcode = '23514'; end if;
      if (new.id, new.wallet_id, new.currency, new.payment_reference, new.amount_minor_units, new.created_at)
        is distinct from (old.id, old.wallet_id, old.currency, old.payment_reference, old.amount_minor_units, old.created_at) then
        raise exception 'reservation identity is immutable' using errcode = '23514';
      end if;
      if old.reservation_status <> 'reserved' or new.reservation_status = 'reserved' then
        raise exception 'reservation has already been resolved' using errcode = '23514';
      end if;
      return new;
    end $$;
    create trigger protected_reservations before update or delete on wallet_reservations for each row execute function guard_wallet_reservation();
    create trigger no_truncate_reservations before truncate on wallet_reservations execute function reject_wallet_history_change();

    -- Reconcile each reservation with its own reserved-account entries, not another payment's money.
    create function validate_wallet_reservation() returns trigger language plpgsql as $$
    declare target_id uuid; reservation wallet_reservations%rowtype; opening_count bigint; resolution_kind text; reserved_credits numeric; reserved_debits numeric;
    begin
      target_id := (to_jsonb(new) ->> tg_argv[0])::uuid;
      if target_id is null then return null; end if;
      select * into strict reservation from wallet_reservations where id = target_id;
      select count(*) into opening_count from ledger_journals where reservation_id = target_id and journal_kind = 'reserve';
      select journal_kind into resolution_kind from ledger_journals where reservation_id = target_id and journal_kind in ('capture', 'release');
      select coalesce(sum(e.amount_minor_units) filter (where e.entry_side = 'credit'), 0),
        coalesce(sum(e.amount_minor_units) filter (where e.entry_side = 'debit'), 0)
      into reserved_credits, reserved_debits
      from ledger_entries e join ledger_journals j on j.id = e.journal_id join ledger_accounts a on a.id = e.account_id
      where j.reservation_id = target_id and a.wallet_id = reservation.wallet_id and a.account_kind = 'wallet_reserved';
      if opening_count <> 1 or reserved_credits <> reservation.amount_minor_units then
        raise exception 'reservation opening does not match its ledger' using errcode = '23514';
      end if;
      if reservation.reservation_status = 'reserved' and (resolution_kind is not null or reserved_debits <> 0) then
        raise exception 'open reservation has resolved entries' using errcode = '23514';
      end if;
      if reservation.reservation_status <> 'reserved' and
        (resolution_kind is distinct from case reservation.reservation_status when 'captured' then 'capture' else 'release' end or reserved_debits <> reservation.amount_minor_units) then
        raise exception 'reservation resolution does not match its ledger' using errcode = '23514';
      end if;
      return null;
    end $$;
    create constraint trigger reservation_consistency after insert or update on wallet_reservations deferrable initially deferred for each row execute function validate_wallet_reservation('id');
    create constraint trigger reservation_journal_consistency after insert on ledger_journals deferrable initially deferred for each row execute function validate_wallet_reservation('reservation_id');

    -- Called by the migration owner after provisioning a separate runtime login; never by the API.
    create function grant_wallet_runtime_access(runtime_role name) returns void language plpgsql as $$
    begin
      execute format('grant usage on schema public to %I', runtime_role);
      execute format('grant select on public.wallets, public.ledger_accounts, public.ledger_balances, public.wallet_operations, public.wallet_reservations, public.ledger_journals, public.ledger_entries, public.wallet_outbox_events to %I', runtime_role);
      execute format('grant insert on public.wallets, public.ledger_accounts, public.wallet_operations, public.wallet_reservations, public.ledger_journals, public.ledger_entries, public.wallet_outbox_events to %I', runtime_role);
      execute format('grant update (wallet_status) on public.wallets to %I', runtime_role);
      execute format('grant update (reservation_status) on public.wallet_reservations to %I', runtime_role);
      -- Row locking requires update privilege on a column; the balance trigger forbids direct edits.
      execute format('grant update (balance_version) on public.ledger_balances to %I', runtime_role);
    end $$;
    revoke all on function grant_wallet_runtime_access(name) from public;
    revoke all on function initialize_wallet_account_balance(), project_wallet_entry() from public;
    comment on table ledger_journals is 'Immutable posted accounting events. No pending provider state is represented as a successful posting.';
    comment on table wallet_operations is 'Idempotency for one wallet action; payment/provider/SMS identities remain separate concepts.';
    comment on table wallet_outbox_events is 'Durable journal notifications. A future dispatcher must tolerate repeat delivery.';
  `.execute(database);
}
