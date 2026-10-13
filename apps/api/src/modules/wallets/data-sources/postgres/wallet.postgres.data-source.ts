import { randomUUID } from 'node:crypto';
import { setTimeout as waitForRetry } from 'node:timers/promises';
import type { Insertable, Kysely } from 'kysely';
import type { DatabaseSchema } from '../../../../infrastructure/database/create-database.js';
import type {
  LedgerEntries,
  LedgerJournals,
  WalletReservations,
} from '../../../../infrastructure/database/database.generated.js';
import type {
  WalletReceipt,
  WalletRequestIdentity,
} from '../../repositories/contracts/wallet.repository.js';
import { WalletError } from '../../domain/wallet-error.js';

/** Read a PostgreSQL SQLSTATE without discarding the original diagnostic cause. */
function sqlState(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('code' in error))
    return undefined;
  return error.code;
}

/** PostgreSQL storage for wallet rows, transaction claims, append-only journals and their outbox. */
export class WalletPostgresDataSource {
  /** The injected connection is either a root pool or the current transaction; only roots call executeOnce/createWallet. */
  constructor(private readonly database: Kysely<DatabaseSchema>) {}

  /** Read both liability accounts in one statement so a concurrent reservation cannot tear the balance. */
  readWallet(walletId: string) {
    return this.database
      .selectFrom('wallets as wallet')
      .innerJoin('ledger_accounts as available', (join) =>
        join
          .onRef('available.wallet_id', '=', 'wallet.id')
          .on('available.account_kind', '=', 'wallet_available'),
      )
      .innerJoin('ledger_accounts as reserved', (join) =>
        join
          .onRef('reserved.wallet_id', '=', 'wallet.id')
          .on('reserved.account_kind', '=', 'wallet_reserved'),
      )
      .innerJoin(
        'ledger_balances as available_balance',
        'available_balance.account_id',
        'available.id',
      )
      .innerJoin(
        'ledger_balances as reserved_balance',
        'reserved_balance.account_id',
        'reserved.id',
      )
      .select([
        'wallet.id',
        'wallet.owner_id',
        'wallet.currency',
        'wallet.wallet_status',
        'available.id as available_account_id',
        'reserved.id as reserved_account_id',
        'available_balance.debits_minor_units as available_debits',
        'available_balance.credits_minor_units as available_credits',
        'reserved_balance.debits_minor_units as reserved_debits',
        'reserved_balance.credits_minor_units as reserved_credits',
      ])
      .where('wallet.id', '=', walletId)
      .executeTakeFirst();
  }

  /** Serialize first-time creation by owner/currency; losing concurrent callers observe the committed accounts. */
  async createWallet(ownerId: string, currency: string) {
    return this.database.transaction().execute(async (transaction) => {
      const inserted = await transaction
        .insertInto('wallets')
        .values({ id: randomUUID(), owner_id: ownerId, currency })
        .onConflict((conflict) =>
          conflict.columns(['owner_id', 'currency']).doNothing(),
        )
        .returning('id')
        .executeTakeFirst();
      if (inserted)
        await transaction
          .insertInto('ledger_accounts')
          .values([
            {
              id: randomUUID(),
              account_code: `wallet:${inserted.id}:available`,
              account_kind: 'wallet_available',
              wallet_id: inserted.id,
              currency,
            },
            {
              id: randomUUID(),
              account_code: `wallet:${inserted.id}:reserved`,
              account_kind: 'wallet_reserved',
              wallet_id: inserted.id,
              currency,
            },
          ])
          .execute();
      const wallet = await transaction
        .selectFrom('wallets')
        .select('id')
        .where('owner_id', '=', ownerId)
        .where('currency', '=', currency)
        .executeTakeFirstOrThrow();
      return new WalletPostgresDataSource(transaction).readWallet(wallet.id);
    });
  }

  /** Lock wallets first, then their accounts in global UUID order; every financial caller follows this order. */
  async lockWallets(walletIds: readonly string[]): Promise<void> {
    const uniqueIds = [...new Set(walletIds)].sort();
    await this.database
      .selectFrom('wallets')
      .select('id')
      .where('id', 'in', uniqueIds)
      .orderBy('id')
      .forUpdate()
      .execute();
    await this.database
      .selectFrom('ledger_balances')
      .select('account_id')
      .where(
        'account_id',
        'in',
        this.database
          .selectFrom('ledger_accounts')
          .select('id')
          .where('wallet_id', 'in', uniqueIds),
      )
      .orderBy('account_id')
      .forUpdate()
      .execute();
  }

  /** Lock a reservation before the owning wallet; resolution callbacks use this same order. */
  lockReservation(reservationId: string) {
    return this.database
      .selectFrom('wallet_reservations')
      .selectAll()
      .where('id', '=', reservationId)
      .forUpdate()
      .executeTakeFirst();
  }

  /** Return only a correctly provisioned, currency-matched system account. */
  readSystemAccount(
    accountId: string,
    accountKind: 'partner_funds' | 'fee_income',
    currency: string,
  ) {
    return this.database
      .selectFrom('ledger_accounts')
      .select('id')
      .where('id', '=', accountId)
      .where('account_kind', '=', accountKind)
      .where('currency', '=', currency)
      .where('wallet_id', 'is', null)
      .executeTakeFirst();
  }

  /** Persist allocation metadata in the caller's transaction; commit triggers verify the matching journal. */
  async insertReservation(
    reservation: Insertable<WalletReservations>,
  ): Promise<void> {
    await this.database
      .insertInto('wallet_reservations')
      .values(reservation)
      .execute();
  }

  /** Update only the resolution state of the locked allocation; database guards reject repeat resolution. */
  async resolveReservation(
    reservationId: string,
    reservationStatus: 'captured' | 'released',
  ): Promise<void> {
    await this.database
      .updateTable('wallet_reservations')
      .set({ reservation_status: reservationStatus })
      .where('id', '=', reservationId)
      .execute();
  }

  /** Post header/entries/outbox together; entry triggers alone maintain the synchronous balance projection. */
  async insertJournal(
    journal: Insertable<LedgerJournals>,
    entries: readonly Insertable<LedgerEntries>[],
  ): Promise<void> {
    // Customer balances are already locked. Shared partner/revenue accounts are always locked afterwards.
    await this.database
      .selectFrom('ledger_balances')
      .select('account_id')
      .where(
        'account_id',
        'in',
        this.database
          .selectFrom('ledger_accounts')
          .select('id')
          .where(
            'id',
            'in',
            entries.map((entry) => entry.account_id),
          )
          .where('wallet_id', 'is', null),
      )
      .orderBy('account_id')
      .forUpdate()
      .execute();
    await this.database.insertInto('ledger_journals').values(journal).execute();
    await this.database
      .insertInto('ledger_entries')
      .values([...entries])
      .execute();
    await this.database
      .insertInto('wallet_outbox_events')
      .values({ id: journal.id, delivered_at: null })
      .execute();
  }

  /** Retry only PostgreSQL-confirmed rollbacks, never a connection loss with an uncertain commit outcome. */
  async executeOnce(
    identity: WalletRequestIdentity,
    action: (
      source: WalletPostgresDataSource,
      operationId: string,
    ) => Promise<WalletReceipt>,
  ): Promise<WalletReceipt> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.claimAndExecute(identity, action);
      } catch (error) {
        const code = sqlState(error);
        if (code === '23505')
          throw new WalletError('IDEMPOTENCY_CONFLICT', { cause: error });
        if (code !== '40001' && code !== '40P01') throw error;
        if (attempt === 2)
          throw new WalletError('CONCURRENT_WRITE', { cause: error });
        await waitForRetry(5 * (attempt + 1));
      }
    }
    throw new WalletError('CONCURRENT_WRITE');
  }

  /** Use the unique claim as the serialization point for duplicate requests, including simultaneous submissions. */
  private claimAndExecute(
    identity: WalletRequestIdentity,
    action: (
      source: WalletPostgresDataSource,
      operationId: string,
    ) => Promise<WalletReceipt>,
  ): Promise<WalletReceipt> {
    return this.database
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (transaction) => {
        const operation = await transaction
          .insertInto('wallet_operations')
          .values({
            id: randomUUID(),
            request_scope: identity.requestScope,
            request_key: identity.requestKey,
            request_fingerprint: identity.requestFingerprint,
          })
          .onConflict((conflict) =>
            conflict.columns(['request_scope', 'request_key']).doNothing(),
          )
          .returning('id')
          .executeTakeFirst();
        if (operation)
          return action(
            new WalletPostgresDataSource(transaction),
            operation.id,
          );
        const existing = await transaction
          .selectFrom('wallet_operations')
          .selectAll()
          .where('request_scope', '=', identity.requestScope)
          .where('request_key', '=', identity.requestKey)
          .executeTakeFirstOrThrow();
        if (existing.request_fingerprint !== identity.requestFingerprint)
          throw new WalletError('IDEMPOTENCY_CONFLICT');
        const journal = await transaction
          .selectFrom('ledger_journals')
          .select(['id', 'reservation_id'])
          .where('id', '=', existing.id)
          .executeTakeFirstOrThrow();
        return {
          operationId: journal.id,
          reservationId: journal.reservation_id,
        };
      });
  }
}

/** Persistence snapshot inferred from the concrete SQL selection; it does not cross application ports. */
export type WalletRecord = NonNullable<
  Awaited<ReturnType<WalletPostgresDataSource['readWallet']>>
>;
