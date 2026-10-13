import {
  assertBalancedJournal,
  type JournalPosting,
} from '../domain/journal.js';
import { WalletError } from '../domain/wallet-error.js';
import type { Wallet, WalletReservation } from '../domain/wallet.js';
import type {
  WalletReceipt,
  WalletRepository,
  WalletRequestIdentity,
  WalletTransaction,
} from './contracts/wallet.repository.js';
import {
  WalletPostgresDataSource,
  type WalletRecord,
} from '../data-sources/postgres/wallet.postgres.data-source.js';

/** Convert exact PostgreSQL strings to domain bigints, keeping SQL row names inside infrastructure. */
function walletFromRecord(record: WalletRecord | undefined): Wallet {
  if (!record) throw new WalletError('WALLET_NOT_FOUND');
  return {
    id: record.id,
    ownerId: record.owner_id,
    currency: record.currency,
    walletStatus: record.wallet_status as Wallet['walletStatus'],
    availableAccountId: record.available_account_id,
    reservedAccountId: record.reserved_account_id,
    availableMinorUnits:
      BigInt(record.available_credits) - BigInt(record.available_debits),
    reservedMinorUnits:
      BigInt(record.reserved_credits) - BigInt(record.reserved_debits),
  };
}

/** Transaction-bound implementation of wallet ports; all methods share the caller's PostgreSQL transaction. */
class WalletTransactionRepository implements WalletTransaction {
  /** Bind to a transaction data source; never create an unrelated connection. */
  constructor(private readonly source: WalletPostgresDataSource) {}

  /** @inheritdoc WalletTransaction.lockWallets */
  async lockWallets(walletIds: readonly string[]): Promise<readonly Wallet[]> {
    await this.source.lockWallets(walletIds);
    const records = await Promise.all(
      [...new Set(walletIds)].map((id) => this.source.readWallet(id)),
    );
    return records.map(walletFromRecord);
  }

  /** @inheritdoc WalletTransaction.lockReservation */
  async lockReservation(reservationId: string): Promise<WalletReservation> {
    const record = await this.source.lockReservation(reservationId);
    if (!record) throw new WalletError('RESERVATION_NOT_FOUND');
    return {
      id: record.id,
      walletId: record.wallet_id,
      currency: record.currency,
      paymentReference: record.payment_reference,
      amountMinorUnits: BigInt(record.amount_minor_units),
      reservationStatus:
        record.reservation_status as WalletReservation['reservationStatus'],
    };
  }

  /** @inheritdoc WalletTransaction.getSystemAccount */
  async getSystemAccount(
    accountId: string,
    accountKind: 'partner_funds' | 'fee_income',
    currency: string,
  ): Promise<string> {
    const account = await this.source.readSystemAccount(
      accountId,
      accountKind,
      currency,
    );
    if (!account) throw new WalletError('LEDGER_CONFIGURATION');
    return account.id;
  }

  /** @inheritdoc WalletTransaction.createReservation */
  createReservation(reservation: WalletReservation): Promise<void> {
    return this.source.insertReservation({
      id: reservation.id,
      wallet_id: reservation.walletId,
      currency: reservation.currency,
      payment_reference: reservation.paymentReference,
      amount_minor_units: reservation.amountMinorUnits,
      reservation_status: reservation.reservationStatus,
    });
  }

  /** @inheritdoc WalletTransaction.resolveReservation */
  resolveReservation(
    reservationId: string,
    reservationStatus: 'captured' | 'released',
  ): Promise<void> {
    return this.source.resolveReservation(reservationId, reservationStatus);
  }

  /** Validate the posting contract, map to storage rows, and leave projection maintenance to PostgreSQL. */
  async postJournal(
    operationId: string,
    posting: JournalPosting,
  ): Promise<WalletReceipt> {
    assertBalancedJournal(posting);
    await this.source.insertJournal(
      {
        id: operationId,
        currency: posting.currency,
        journal_kind: posting.journalKind,
        reservation_id: posting.reservationId ?? null,
        evidence_reference: posting.evidenceReference ?? null,
      },
      posting.entries.map((entry, index) => ({
        journal_id: operationId,
        line_number: index + 1,
        account_id: entry.accountId,
        currency: posting.currency,
        entry_side: entry.side,
        amount_minor_units: entry.amountMinorUnits,
      })),
    );
    return { operationId, reservationId: posting.reservationId ?? null };
  }
}

/** Coordinate wallet PostgreSQL access and mappings. Balance reads are not cache eligible; no Redis copies exist to invalidate.
 * executeOnce owns the transaction boundary and supplies a bound repository for every participating operation.
 */
export class WalletRepositoryImpl implements WalletRepository {
  /** Inject the root data source; its connection lifecycle belongs to the composition owner. */
  constructor(private readonly source: WalletPostgresDataSource) {}

  /** @inheritdoc WalletRepository.createWallet */
  async createWallet(ownerId: string, currency: string): Promise<Wallet> {
    return walletFromRecord(await this.source.createWallet(ownerId, currency));
  }

  /** @inheritdoc WalletRepository.getWallet */
  async getWallet(walletId: string): Promise<Wallet> {
    return walletFromRecord(await this.source.readWallet(walletId));
  }

  /** @inheritdoc WalletRepository.executeOnce */
  executeOnce(
    identity: WalletRequestIdentity,
    action: (
      transaction: WalletTransaction,
      operationId: string,
    ) => Promise<WalletReceipt>,
  ): Promise<WalletReceipt> {
    return this.source.executeOnce(identity, (source, operationId) =>
      action(new WalletTransactionRepository(source), operationId),
    );
  }
}
