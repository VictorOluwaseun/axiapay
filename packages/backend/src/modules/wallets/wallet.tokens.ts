/** Private provider identities prevent feature callers from depending on concrete persistence. */
export const WALLET = Object.freeze({
  repository: Symbol('WalletRepository'),
  funding: Symbol('FundingVerification'),
  paymentOutcome: Symbol('PaymentOutcomeVerification'),
});
