import type { Money } from '@axiapay/payments-runtime/modules/wallets/domain/money';

/** Provider environment is persisted with every request and duplicate-payment key. */
export type FundingEnvironment = 'test' | 'live';

/** Server-bound funding request; its UUID is also the immutable merchant reference sent to the partner. */
export interface FundingRequest {
  readonly id: string;
  readonly ownerId: string;
  readonly walletId: string;
  readonly value: Money;
  readonly fundingOptionId: string;
  readonly adapterId: string;
  readonly environment: FundingEnvironment;
  readonly partnerAccountId: string;
  readonly payerEmail: string;
  readonly requestKey: string;
  readonly requestFingerprint: string;
  readonly initializationStartedAt: Date | null;
  readonly checkoutUrl: string | null;
  readonly externalMovementId: string | null;
  readonly operationId: string | null;
}

/** Canonical partner response, independently obtained with server credentials; pending outcomes grant no value. */
export interface VerifiedFundingPayment {
  readonly reference: string;
  readonly externalMovementId: string;
  readonly value: Money;
  readonly isSuccessful: boolean;
}

/** Stable failures shared by application workflows and delivery adapters; causes remain internal. */
export class FundingError extends Error {
  /** Preserve safe codes and diagnostic causes without retaining provider response bodies. */
  constructor(
    readonly code:
      | 'FUNDING_UNAVAILABLE'
      | 'FUNDING_NOT_FOUND'
      | 'FUNDING_CONFLICT'
      | 'INVALID_FUNDING'
      | 'INVALID_WEBHOOK'
      | 'FUNDING_UNCONFIRMED',
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = 'FundingError';
  }
}

/** Require exact reference and financial terms; overpayments and partial payments require separate review, never implicit credit. */
export function assertFundingPayment(
  request: FundingRequest,
  payment: VerifiedFundingPayment,
): void {
  if (
    payment.reference !== request.id ||
    payment.value.currency !== request.value.currency ||
    payment.value.amountMinorUnits !== request.value.amountMinorUnits
  ) {
    throw new FundingError('INVALID_FUNDING');
  }
  if (payment.isSuccessful !== true) {
    throw new FundingError('FUNDING_UNCONFIRMED');
  }
}

/** Customer-visible AxiaPay checkout option; routing and clearing account identities remain server-owned. */
export interface FundingOption {
  readonly id: string;
  readonly displayName: string;
  readonly currency: string;
  readonly minimumAmountMinorUnits: bigint;
  readonly maximumAmountMinorUnits: bigint;
}

/** Encode internal evidence without reserving delimiters in an adapter's economic payment identity. */
export function fundingEvidence(
  requestId: string,
  externalMovementId?: string,
): string {
  return JSON.stringify([requestId, externalMovementId ?? null]);
}
