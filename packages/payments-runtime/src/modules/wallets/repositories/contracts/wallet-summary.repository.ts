import type { WalletSummary } from '../../domain/wallet-summary.js';

/** Cache-aside display reads keyed by authenticated account and validated currency; never creates missing wallets. */
export interface WalletSummaryRepository {
  /** Return the owner's summary or null; cache hits are SQL-free and unavailable caches fall back to PostgreSQL. */
  findByOwner(ownerId: string, currency: string): Promise<WalletSummary | null>;
}
