import type { Money } from './money.js';
import { WalletError } from './wallet-error.js';

/** Authoritative wallet snapshot; amounts are read from the two liability accounts. */
export interface Wallet {
  readonly id: string;
  readonly ownerId: string;
  readonly currency: string;
  readonly walletStatus: 'active' | 'frozen' | 'closed';
  readonly availableAccountId: string;
  readonly reservedAccountId: string;
  readonly availableMinorUnits: bigint;
  readonly reservedMinorUnits: bigint;
}

/** Bind one payment instruction to funds; resolution is full capture or full release for this increment. */
export interface WalletReservation {
  readonly id: string;
  readonly walletId: string;
  readonly paymentReference: string;
  readonly amountMinorUnits: bigint;
  readonly currency: string;
  readonly reservationStatus: 'reserved' | 'captured' | 'released';
}

/** Require ownership inside every customer business operation, including balance reads. */
export function assertWalletOwner(wallet: Wallet, actorId: string): void {
  if (wallet.ownerId !== actorId) {
    throw new WalletError('FORBIDDEN');
  }
}

/** Reject restricted wallets for new incoming or outgoing customer instructions. */
export function assertWalletActive(wallet: Wallet): void {
  if (wallet.walletStatus !== 'active') {
    throw new WalletError('WALLET_RESTRICTED');
  }
}

/** Enforce currency and available funds using a transaction-locked snapshot. */
export function assertCanSpend(wallet: Wallet, value: Money): void {
  assertWalletActive(wallet);
  if (wallet.currency !== value.currency) {
    throw new WalletError('CURRENCY_MISMATCH');
  }
  if (wallet.availableMinorUnits < value.amountMinorUnits) {
    throw new WalletError('INSUFFICIENT_FUNDS');
  }
}

/** Prevent another resolution of money already captured or released. */
export function assertReservationOpen(reservation: WalletReservation): void {
  if (reservation.reservationStatus !== 'reserved') {
    throw new WalletError('RESERVATION_RESOLVED');
  }
}
