import {
  maximumMinorUnits,
  money,
  type Money,
} from '@axiapay/payments-runtime/modules/wallets/domain/money';

/** Stable conversion failures; uncertain external outcomes never become confirmed rejection. */
export class ConversionError extends Error {
  /** Carry a public error code without provider payloads or customer details. */
  constructor(
    readonly code:
      | 'CONVERSION_UNAVAILABLE'
      | 'CONVERSION_NOT_FOUND'
      | 'CONVERSION_CONFLICT'
      | 'INVALID_CONVERSION'
      | 'AIRTIME_INELIGIBLE'
      | 'QUOTE_EXPIRED'
      | 'CONVERSION_TERMS_CHANGED',
  ) {
    super(code);
    this.name = 'ConversionError';
  }
}

/** Administrator-selected commercial terms. All values are exact, in one currency; no defaults enable a network. */
export interface ConversionOffer {
  readonly id: string;
  readonly displayName: string;
  readonly networkCode: string;
  readonly currency: string;
  readonly termsVersion: string;
  readonly rateNumerator: bigint;
  readonly rateDenominator: bigint;
  readonly fixedFeeMinorUnits: bigint;
  readonly feeBasisPoints: number;
  readonly minimumAirtimeMinorUnits: bigint;
  readonly maximumAirtimeMinorUnits: bigint;
  readonly airtimeStepMinorUnits: bigint;
  readonly quoteValiditySeconds: number;
  readonly transferWindowSeconds: number;
}

/** Disclosed arithmetic: floor gross credit, then ceil proportional fee, then subtract the combined fee. */
export interface ConversionAmounts {
  readonly airtimeValue: Money;
  readonly grossCreditValue: Money;
  readonly feeMinorUnits: bigint;
  readonly netCreditValue: Money;
}

/** Immutable eligibility and price snapshot, bound to its owner, source phone, destination wallet and provider realm. */
export interface ConversionQuote extends ConversionAmounts {
  readonly id: string;
  readonly ownerId: string;
  readonly walletId: string;
  readonly sourcePhoneNumber: string;
  readonly offer: ConversionOffer;
  readonly providerId: string;
  readonly partnerAccountId: string;
  readonly providerProductCode: string;
  readonly eligibilityReference: string;
  readonly quotedAt: Date;
  readonly expiresAt: Date;
}

/** Safe, fixed transfer destination issued for this accepted conversion. It conveys no receipt or credit guarantee. */
export interface TransferInstructions {
  readonly instructionReference: string;
  readonly receivingPhoneNumber: string;
  readonly description: string;
  readonly issuedAt: Date;
}

/** Exceptions require an audited resolution; neither repricing nor refund terms have been selected. */
export type ConversionExceptionCode =
  | 'amount_mismatch'
  | 'late_receipt'
  | 'terms_mismatch'
  | 'verification_failed'
  | 'movement_conflict';

/** Authenticated terminal observation, saved before ledger posting. Exceptions retain receipt evidence for operator recovery. */
export interface ConversionOutcome {
  readonly outcome: 'verified' | 'exception';
  readonly exceptionCode: ConversionExceptionCode | null;
  readonly externalMovementId: string | null;
  readonly evidenceReference: string;
  readonly receivedAt: Date | null;
  readonly observedAirtimeValue: Money | null;
  readonly receiptFingerprint: string;
}

/** Accepted intent and append-only progress. Credited state is derived from the matching committed ledger journal. */
export interface ConversionRequest {
  readonly id: string;
  readonly quote: ConversionQuote;
  readonly requestKey: string;
  readonly acceptedAt: Date;
  readonly receiveBy: Date;
  readonly initializationStartedAt: Date | null;
  readonly instructions: TransferInstructions | null;
  readonly outcome: ConversionOutcome | null;
  readonly operationId: string | null;
  readonly hasPostingConflict: boolean;
}

/** Validate a bounded identity without trimming or silently changing a logical request key. */
export function assertConversionReference(reference: string): void {
  if (
    typeof reference !== 'string' ||
    !reference ||
    reference.length > 200 ||
    reference.trim() !== reference ||
    reference.includes('\u0000')
  ) {
    throw new ConversionError('INVALID_CONVERSION');
  }
}

/** Require normalized UUIDs before database access; HTTP delivery normalizes validated route identities. */
export function assertConversionId(id: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/.test(
      id,
    )
  ) {
    throw new ConversionError('INVALID_CONVERSION');
  }
}

/** Phone numbers remain strings; explicit network eligibility comes from the adapter, never prefix inference. */
export function assertSourcePhone(phoneNumber: string): void {
  if (!/^\+[1-9][0-9]{7,14}(?![\s\S])/.test(phoneNumber)) {
    throw new ConversionError('INVALID_CONVERSION');
  }
}

/** Validate configuration at composition time, including positive net credit across the configured amount range. */
export function assertConversionOffer(offer: ConversionOffer): void {
  assertConversionReference(offer.termsVersion);
  if (
    !/^[a-z][a-z0-9-]{0,63}(?![\s\S])/.test(offer.id) ||
    !/^[a-z][a-z0-9-]{0,63}(?![\s\S])/.test(offer.networkCode) ||
    !offer.displayName.trim() ||
    offer.displayName.length > 200 ||
    /\p{Cc}/u.test(offer.displayName)
  ) {
    throw new ConversionError('INVALID_CONVERSION');
  }
  if (
    offer.rateNumerator <= 0n ||
    offer.rateNumerator > maximumMinorUnits ||
    offer.rateDenominator <= 0n ||
    offer.rateDenominator > maximumMinorUnits ||
    offer.fixedFeeMinorUnits < 0n ||
    offer.fixedFeeMinorUnits > maximumMinorUnits ||
    !Number.isInteger(offer.feeBasisPoints) ||
    offer.feeBasisPoints < 0 ||
    offer.feeBasisPoints > 10000 ||
    offer.airtimeStepMinorUnits <= 0n ||
    offer.airtimeStepMinorUnits > maximumMinorUnits ||
    offer.maximumAirtimeMinorUnits < offer.minimumAirtimeMinorUnits
  ) {
    throw new ConversionError('INVALID_CONVERSION');
  }
  for (const seconds of [
    offer.quoteValiditySeconds,
    offer.transferWindowSeconds,
  ]) {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400) {
      throw new ConversionError('INVALID_CONVERSION');
    }
  }
  calculateConversionAmounts(offer, offer.minimumAirtimeMinorUnits);
  // Check the upper bound independently of the step, so every valid amount fits SQL bigint.
  calculateAmounts(
    offer,
    money(offer.maximumAirtimeMinorUnits, offer.currency),
  );
}

/** Enforce supported face-value limits and increments before calculating a quote. */
export function calculateConversionAmounts(
  offer: ConversionOffer,
  airtimeMinorUnits: bigint,
): ConversionAmounts {
  const airtimeValue = money(airtimeMinorUnits, offer.currency);
  if (
    airtimeMinorUnits < offer.minimumAirtimeMinorUnits ||
    airtimeMinorUnits > offer.maximumAirtimeMinorUnits ||
    (airtimeMinorUnits - offer.minimumAirtimeMinorUnits) %
      offer.airtimeStepMinorUnits !==
      0n
  ) {
    throw new ConversionError('AIRTIME_INELIGIBLE');
  }
  return calculateAmounts(offer, airtimeValue);
}

/** Use bigint throughout; fees cannot consume all proceeds or create a zero/negative wallet credit. */
function calculateAmounts(
  offer: ConversionOffer,
  airtimeValue: Money,
): ConversionAmounts {
  const grossCreditValue = money(
    (airtimeValue.amountMinorUnits * offer.rateNumerator) /
      offer.rateDenominator,
    offer.currency,
  );
  const feeMinorUnits =
    offer.fixedFeeMinorUnits +
    (grossCreditValue.amountMinorUnits * BigInt(offer.feeBasisPoints) + 9999n) /
      10000n;
  const netCreditValue = money(
    grossCreditValue.amountMinorUnits - feeMinorUnits,
    offer.currency,
  );
  return { airtimeValue, grossCreditValue, feeMinorUnits, netCreditValue };
}

/** Canonical configuration identity prevents a quote from silently acquiring replacement terms or a different product binding. */
export function offerFingerprint(offer: ConversionOffer): string {
  return JSON.stringify([
    offer.id,
    offer.displayName,
    offer.networkCode,
    offer.currency,
    offer.termsVersion,
    offer.rateNumerator.toString(),
    offer.rateDenominator.toString(),
    offer.fixedFeeMinorUnits.toString(),
    offer.feeBasisPoints,
    offer.minimumAirtimeMinorUnits.toString(),
    offer.maximumAirtimeMinorUnits.toString(),
    offer.airtimeStepMinorUnits.toString(),
    offer.quoteValiditySeconds,
    offer.transferWindowSeconds,
  ]);
}

/** Complete first-party correlation contract; adapters must persist and return it unchanged when inspecting receipt. */
export function conversionFingerprint(request: ConversionRequest): string {
  const quote = request.quote;
  return JSON.stringify([
    request.id,
    quote.id,
    quote.ownerId,
    quote.walletId,
    quote.sourcePhoneNumber,
    offerFingerprint(quote.offer),
    quote.providerId,
    quote.partnerAccountId,
    quote.providerProductCode,
    quote.eligibilityReference,
    quote.airtimeValue.amountMinorUnits.toString(),
    quote.grossCreditValue.amountMinorUnits.toString(),
    quote.feeMinorUnits.toString(),
    quote.netCreditValue.amountMinorUnits.toString(),
    quote.quotedAt.toISOString(),
    quote.expiresAt.toISOString(),
    request.acceptedAt.toISOString(),
    request.receiveBy.toISOString(),
  ]);
}

/** An elapsed transfer deadline alone is never proof that no airtime moved. */
export function conversionStatus(
  request: ConversionRequest,
  now = new Date(),
):
  | 'preparing'
  | 'awaiting_receipt'
  | 'verification_pending'
  | 'credit_pending'
  | 'credited'
  | 'exception' {
  if (request.operationId) {
    return 'credited';
  }
  if (request.hasPostingConflict) {
    return 'exception';
  }
  if (request.outcome?.outcome === 'exception') {
    return 'exception';
  }
  if (request.outcome?.outcome === 'verified') {
    return 'credit_pending';
  }
  if (now > request.receiveBy) {
    return 'verification_pending';
  }
  if (!request.instructions) {
    return 'preparing';
  }
  return 'awaiting_receipt';
}
