import type { WalletSummary } from '../../domain/wallet-summary.js';

/** Generation captured before the authoritative snapshot read; invalidation makes old fills unusable. */
export interface WalletSummaryFillTicket {
  readonly namespace: string;
  readonly epoch: string;
  readonly generation: string;
}

/** Atomically observed cached summary and conditional-fill generation. */
export interface WalletSummaryLookup {
  readonly snapshot: WalletSummary | null;
  readonly ticket: WalletSummaryFillTicket;
}

/** Display-only cache storage; repository owns lookup policy; API infrastructure owns durable invalidation delivery. */
export interface WalletSummaryCache {
  /** Verify the signed, account/currency-scoped summary and its expiry without SQL. */
  read(
    ownerId: string,
    currency: string,
    now: Date,
  ): Promise<WalletSummaryLookup | null>;
  /** Publish for at most 15 seconds only while the original pre-read fence remains current. */
  write(
    snapshot: WalletSummary,
    now: Date,
    ticket: WalletSummaryFillTicket,
  ): Promise<void>;
}
