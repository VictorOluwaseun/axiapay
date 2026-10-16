/** Private provider identities prevent feature callers from depending on concrete persistence. */
export const WALLET = Object.freeze({
  repository: Symbol('WalletRepository'),
  summaries: Symbol('WalletSummaryRepository'),
  summaryCache: Symbol('WalletSummaryCache'),
  funding: Symbol('FundingVerification'),
  paymentOutcome: Symbol('PaymentOutcomeVerification'),
});
