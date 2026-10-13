/** Stable business failures; delivery adapters map these codes without exposing database details. */
export class WalletError extends Error {
  /** Preserve a machine-readable failure and optional internal cause. */
  constructor(
    public readonly code:
      | 'INVALID_AMOUNT'
      | 'INVALID_CURRENCY'
      | 'INVALID_REFERENCE'
      | 'WALLET_NOT_FOUND'
      | 'FORBIDDEN'
      | 'WALLET_RESTRICTED'
      | 'CURRENCY_MISMATCH'
      | 'INSUFFICIENT_FUNDS'
      | 'INVALID_TRANSFER'
      | 'IDEMPOTENCY_CONFLICT'
      | 'RESERVATION_NOT_FOUND'
      | 'RESERVATION_RESOLVED'
      | 'OUTCOME_UNCONFIRMED'
      | 'INVALID_EVIDENCE'
      | 'VERIFICATION_UNAVAILABLE'
      | 'LEDGER_CONFIGURATION'
      | 'CONCURRENT_WRITE',
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = 'WalletError';
  }
}
