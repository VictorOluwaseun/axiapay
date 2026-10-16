import type { JournalPosting } from '../../domain/journal.js';
import type { Wallet, WalletReservation } from '../../domain/wallet.js';

/** Immutable result of an action; replay returns the same identifiers, not a newly computed balance. */
export interface WalletReceipt {
  readonly operationId: string;
  readonly reservationId: string | null;
}

/** Canonical logical identity shared by all transports; fingerprints include every financial input. */
export interface WalletRequestIdentity {
  readonly requestScope: string;
  readonly requestKey: string;
  readonly requestFingerprint: string;
}

/** Repositories bound to one transaction; callbacks must contain no network calls or unrelated work. */
export interface WalletTransaction {
  /** Lock wallets and their balance rows in deterministic order before returning authoritative snapshots. */
  lockWallets(walletIds: readonly string[]): Promise<readonly Wallet[]>;
  /** Lock the allocation before inspecting its resolution status. */
  lockReservation(reservationId: string): Promise<WalletReservation>;
  /** Find a provisioned system account, rejecting incorrect currency or accounting role. */
  getSystemAccount(
    accountId: string,
    accountKind: 'partner_funds' | 'fee_income',
    currency: string,
  ): Promise<string>;
  /** Insert one allocation, using the opening operation identity as the reservation identity. */
  createReservation(reservation: WalletReservation): Promise<void>;
  /** Resolve an already-locked reservation together with its journal; rollback restores both. */
  resolveReservation(
    reservationId: string,
    reservationStatus: 'captured' | 'released',
  ): Promise<void>;
  /** Persist an immutable journal, update balances, and enqueue its notification atomically. */
  postJournal(
    operationId: string,
    posting: JournalPosting,
  ): Promise<WalletReceipt>;
}

/** Wallet persistence boundary. All reads bypass cache for immediate consistency; no cache keys exist. */
export interface WalletRepository {
  /** Create an empty wallet and both accounts atomically, joining any caller transaction; repeated owner/currency calls return it. */
  createWallet(ownerId: string, currency: string): Promise<Wallet>;
  /** Read one consistent database snapshot; authorization belongs to the caller's service operation. */
  getWallet(walletId: string): Promise<Wallet>;
  /** Claim a durable identity and bind the callback to one transaction, or replay its committed receipt.
   * Different fingerprints conflict. Failed callbacks roll back claims, journals, reservations and outbox.
   * Infrastructure retries only known rolled-back deadlocks/serialization failures, with a bounded limit.
   */
  executeOnce(
    identity: WalletRequestIdentity,
    action: (
      transaction: WalletTransaction,
      operationId: string,
    ) => Promise<WalletReceipt>,
  ): Promise<WalletReceipt>;
}
