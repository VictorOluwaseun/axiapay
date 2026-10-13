import type { Money } from '../domain/money.js';

/** Provider evidence already verified by a trusted integration; never construct this from customer input. */
export interface ConfirmedFunding {
  readonly walletId: string;
  readonly partnerAccountId: string;
  readonly externalMovementId: string;
  readonly evidenceReference: string;
  readonly value: Money;
}

/** Verify actual settled funding and its intended wallet; pending or untrusted evidence must throw. */
export interface FundingVerification {
  /** Resolve and authenticate evidence outside the wallet database transaction. */
  verifyFunding(evidenceReference: string): Promise<ConfirmedFunding>;
}

/** Final provider evidence. Failure is releasable only when no debit remains outstanding. */
export type VerifiedPaymentOutcome =
  | { readonly outcome: 'unknown'; readonly paymentReference: string }
  | {
      readonly outcome: 'failed';
      readonly paymentReference: string;
      readonly fundsSafeToRelease: boolean;
      readonly evidenceReference: string;
    }
  | {
      readonly outcome: 'succeeded';
      readonly paymentReference: string;
      readonly evidenceReference: string;
      readonly partnerAccountId: string;
      readonly feeAccountId: string | null;
      readonly principal: Money;
      readonly feeMinorUnits: bigint;
    };

/** Supply authoritative payment outcomes; SMS delivery, client claims and timeouts are insufficient. */
export interface PaymentOutcomeVerification {
  /** Verify settlement/deduction evidence outside the database transaction; uncertain results remain unknown. */
  verifyOutcome(evidenceReference: string): Promise<VerifiedPaymentOutcome>;
}
