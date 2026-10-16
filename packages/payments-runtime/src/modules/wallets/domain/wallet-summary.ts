import type { Wallet } from './wallet.js';

/** Owner-scoped display snapshot; excludes ledger identities and never authorizes financial operations. */
export type WalletSummary = Pick<
  Wallet,
  | 'id'
  | 'ownerId'
  | 'currency'
  | 'walletStatus'
  | 'availableMinorUnits'
  | 'reservedMinorUnits'
>;
