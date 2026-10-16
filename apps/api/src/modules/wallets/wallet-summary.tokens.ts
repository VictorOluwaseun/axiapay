/** Private wallet summary providers, separate from the authoritative financial repository. */
export const WALLET_SUMMARY = {
  cache: Symbol('WalletSummaryCache'),
  invalidations: Symbol('WalletSummaryInvalidationRepository'),
} as const;
