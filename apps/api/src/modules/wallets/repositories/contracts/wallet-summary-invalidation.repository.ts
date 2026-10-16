/** Deliver committed wallet invalidations; failures remain durable and do not undo completed financial operations. */
export interface WalletSummaryInvalidationRepository {
  /** Attempt delivery with a bounded post-commit wait; startup and periodic recovery retry remaining work. */
  flush(): Promise<void>;
}
