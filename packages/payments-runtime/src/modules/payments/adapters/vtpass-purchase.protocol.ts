import { assertBillDisplayText } from '../domain/bill-account.js';
import { createHash } from 'node:crypto';
import {
  PaymentError,
  paymentTermsFingerprint,
  type PaymentQuote,
  type ServicePayment,
} from '../domain/payment.js';
import type { ProviderPaymentResult } from '../ports/service-payment-provider.js';
import type { PaymentErrorReason } from '../domain/payment-error-reasons.js';
import {
  vtpassMinorUnits,
  vtpassMovementId,
  vtpassObject,
  isVtpassObject,
  vtpassRequestId,
} from './vtpass-airtime.protocol.js';

/** Adapter-owned wire fields; exact decimals remain strings until serialization, and optional insurance names are never transport DTOs. */
export interface VtpassPurchaseRequest {
  readonly request_id: string;
  readonly serviceID: string;
  readonly phone: string;
  readonly billersCode?: string;
  readonly variation_code?: string;
  readonly amount?: string;
  readonly quantity?: '1';
  readonly subscription_type?: 'change';
  readonly [field: string]: string | undefined;
}

/** Split an adapter-validated catalogue SKU for mapping; profile validation owns its syntax and supported service/variation shape. */
export function vtpassProductSelection(code: string): {
  serviceId: string;
  variationCode: string | undefined;
} {
  const [serviceId, variationCode] = code.split(':');
  return { serviceId: serviceId!, variationCode };
}

/** Encode trusted toRequest fields: amount and quantity remain exact number tokens; all other values are JSON strings. */
export function serializeVtpassPurchase(
  request: VtpassPurchaseRequest,
): string {
  return `{${Object.entries(request)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const encoded =
        key === 'amount' || key === 'quantity' ? value : JSON.stringify(value);
      return `${JSON.stringify(key)}:${encoded}`;
    })
    .join(',')}}`;
}

/** Bound authenticated provider display fields without returning raw upstream objects to workflows. */
export function vtpassEvidenceText(
  value: unknown,
  maximumLength = 200,
): string {
  assertBillDisplayText(value as string, maximumLength);
  return value as string;
}

/** Produce a bounded reference for a non-purchasing authenticated observation without storing customer data in diagnostic references. */
export function vtpassObservationReference(
  environment: string,
  kind: string,
  identity: readonly unknown[],
  response: Record<string, unknown>,
): string {
  return `vtpass:${environment}:${kind}:${createHash('sha256')
    .update(JSON.stringify([identity, response]))
    .digest('hex')}`;
}

/** Confirm a current fixed variation matches the accepted first-party principal; provider repricing requires another review, never a silent amount change. */
export function assertVtpassVariationPrice(
  response: Record<string, unknown>,
  quote: PaymentQuote,
  { serviceId, variationCode }: ReturnType<typeof vtpassProductSelection>,
): void {
  const content = vtpassObject(response.content);
  const variations = content.variations ?? content.varations;
  if (
    response.response_description !== '000' ||
    content.serviceID !== serviceId ||
    !Array.isArray(variations)
  ) {
    throw new PaymentError('PAYMENT_UNAVAILABLE');
  }
  const matches = variations
    .map(vtpassObject)
    .filter((variation) => variation.variation_code === variationCode);
  if (
    matches.length !== 1 ||
    vtpassMinorUnits(matches[0]!.variation_amount) !==
      quote.principal.amountMinorUnits ||
    matches[0]!.fixedPrice !== 'Yes'
  ) {
    throw new PaymentError('PAYMENT_UNAVAILABLE', {
      reason: 'PROVIDER_AMOUNT_MISMATCH',
    });
  }
}

/** Resolve funds only from independently authenticated, exact request/recipient/product/principal evidence. Unknown or incomplete observations stay pending. */
export function vtpassTransactionResult(
  settings: { readonly environment: string },
  response: Record<string, unknown>,
  payment: ServicePayment,
  expected: {
    readonly productNames: readonly string[];
    readonly transactionType: string;
    readonly recipients: readonly string[];
  },
): ProviderPaymentResult {
  const identity = {
    paymentId: payment.id,
    termsFingerprint: paymentTermsFingerprint(payment),
  };
  const requestId = vtpassRequestId(payment);
  if (response.requestId !== undefined && response.requestId !== requestId) {
    throw new PaymentError('INVALID_PROVIDER_EVIDENCE', {
      reason: 'PROVIDER_REQUEST_MISMATCH',
    });
  }
  const content = response.content;
  if (!isVtpassObject(content) || !isVtpassObject(content.transactions)) {
    return { ...identity, outcome: 'pending' };
  }
  const transaction = content.transactions;
  const delivered =
    response.code === '000' && transaction.status === 'delivered';
  const failed =
    ['016', '091'].includes(String(response.code)) &&
    transaction.status === 'failed';
  const reversed = response.code === '040' && transaction.status === 'reversed';
  if (!delivered && !failed && !reversed) {
    return { ...identity, outcome: 'pending' };
  }
  /** Reject a specific evidence mismatch without leaking supplied values. */
  const requireEvidence = (
    matches: boolean,
    reason: PaymentErrorReason,
  ): void => {
    if (!matches) {
      throw new PaymentError('INVALID_PROVIDER_EVIDENCE', { reason });
    }
  };
  requireEvidence(
    response.requestId !== undefined,
    'PROVIDER_REQUEST_MISMATCH',
  );
  requireEvidence(
    typeof transaction.unique_element === 'string' &&
      expected.recipients.includes(transaction.unique_element),
    'PROVIDER_RECIPIENT_MISMATCH',
  );
  requireEvidence(
    vtpassMinorUnits(transaction.amount) ===
      payment.quote.principal.amountMinorUnits,
    'PROVIDER_AMOUNT_MISMATCH',
  );
  requireEvidence(
    (!delivered && transaction.product_name === undefined) ||
      (typeof transaction.product_name === 'string' &&
        expected.productNames.includes(transaction.product_name)),
    'PROVIDER_PRODUCT_MISMATCH',
  );
  const movementId = vtpassMovementId(transaction.transactionId);
  const evidenceReference = `vtpass:${settings.environment}:${movementId}`;
  if (!delivered) {
    return {
      ...identity,
      outcome: 'failed',
      providerTransactionReference: movementId,
      evidenceReference: reversed
        ? `${evidenceReference}:refund:${vtpassMovementId(transaction.wallet_credit_id, 'PROVIDER_REFUND_REFERENCE_INVALID')}`
        : evidenceReference,
      fundsSafeToRelease: true,
    };
  }
  requireEvidence(
    transaction.type === expected.transactionType,
    'PROVIDER_SERVICE_MISMATCH',
  );
  requireEvidence(
    transaction.quantity === 1 || transaction.quantity === '1',
    'PROVIDER_QUANTITY_MISMATCH',
  );
  requireEvidence(
    vtpassMinorUnits(transaction.unit_price) ===
      payment.quote.principal.amountMinorUnits,
    'PROVIDER_UNIT_PRICE_MISMATCH',
  );
  requireEvidence(
    vtpassMinorUnits(response.amount) ===
      payment.quote.principal.amountMinorUnits,
    'PROVIDER_PURCHASE_AMOUNT_MISMATCH',
  );
  return {
    ...identity,
    outcome: 'succeeded',
    providerTransactionReference: movementId,
    evidenceReference,
  };
}
