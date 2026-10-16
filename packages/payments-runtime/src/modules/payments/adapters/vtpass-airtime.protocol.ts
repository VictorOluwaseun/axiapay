import { isPhoneNumber } from 'class-validator';
import { PaymentError, type ServicePayment } from '../domain/payment.js';
import { maximumMinorUnits } from '../../wallets/domain/money.js';
import {
  isAsciiDigits,
  isUnsignedDecimalText,
} from '../../../shared/domain/numeric-text.js';

/** VTpass's domestic airtime purchase fields. Amount is exact decimal text, encoded as a JSON number token at the HTTP boundary. */
export interface VtpassAirtimeRequest {
  readonly request_id: string;
  readonly serviceID: string;
  readonly amount: string;
  readonly phone: string;
}

/** Convert the persisted one-time claim into VTpass's Lagos-time reference; restart, midnight and later enquiries must never generate another identity. */
export function vtpassRequestId(payment: ServicePayment): string {
  const startedAt = payment.submissionStartedAt;
  if (!startedAt || !Number.isFinite(startedAt.getTime())) {
    throw new PaymentError('INVALID_PAYMENT', {
      reason: 'EXECUTION_CLAIM_MISSING',
    });
  }
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(startedAt);
  const values = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );
  return `${values.year}${values.month}${values.day}${values.hour}${values.minute}${payment.id.replaceAll('-', '')}`;
}

/** Check Nigeria-specific phone eligibility for VTpass using class-validator; callers supply boundary-normalized E.164 numbers. */
export function supportsVtpassPhoneNumber(phoneNumber: string): boolean {
  return isPhoneNumber(phoneNumber, 'NG');
}

/** Format an already validated Nigerian E.164 recipient as domestic digits. Validation belongs to validate; this function only transforms its input. */
export function formatVtpassPhoneNumber(phoneNumber: string): string {
  return `0${phoneNumber.slice(4)}`;
}

/** Format already validated domain Money minor units as exact naira; positive/range invariants belong to the domain. */
export function formatVtpassNaira(amountMinorUnits: bigint): string {
  return `${amountMinorUnits / 100n}.${(amountMinorUnits % 100n).toString().padStart(2, '0')}`;
}

/** Read exact positive naira amounts from parsed number tokens or strings; reject exponent notation, extra precision and overflow. */
export function vtpassMinorUnits(value: unknown): bigint {
  if (typeof value !== 'string' || !isUnsignedDecimalText(value, 17, 2)) {
    throw new PaymentError('INVALID_PROVIDER_EVIDENCE', {
      reason: 'PROVIDER_AMOUNT_INVALID',
    });
  }
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (amount <= 0n || amount > maximumMinorUnits) {
    throw new PaymentError('INVALID_PROVIDER_EVIDENCE', {
      reason: 'PROVIDER_AMOUNT_OUT_OF_RANGE',
    });
  }
  return amount;
}

/** Narrow an upstream object once, allowing callers to retain pending outcomes when a transaction record is absent. */
export function isVtpassObject(
  value: unknown,
): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Require an upstream object where the provider protocol promises one; absent transaction records can use isVtpassObject instead. */
export function vtpassObject(value: unknown): Record<string, unknown> {
  if (!isVtpassObject(value)) {
    throw new PaymentError('INVALID_PROVIDER_EVIDENCE', {
      reason: 'PROVIDER_RESPONSE_INVALID_OBJECT',
    });
  }
  return value as Record<string, unknown>;
}

/** Preserve all JSON numeric lexemes before rounding, including long movement IDs and fractional amounts. Parse errors exclude response text from diagnostics. */
export function parseVtpassJson(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      text,
      (_key: string, value: unknown, context?: { source: string }) => {
        if (typeof value === 'number') {
          return context?.source;
        }
        return value;
      },
    );
  } catch {
    throw new PaymentError('INVALID_PROVIDER_EVIDENCE', {
      reason: 'PROVIDER_RESPONSE_INVALID_JSON',
    });
  }
  return vtpassObject(parsed);
}

/** Encode the trusted toRequest output, preserving its formatted amount as an exact JSON number token. */
export function serializeVtpassAirtime(request: VtpassAirtimeRequest): string {
  return `{"request_id":${JSON.stringify(request.request_id)},"serviceID":${JSON.stringify(request.serviceID)},"amount":${request.amount},"phone":${JSON.stringify(request.phone)}}`;
}

/** Accept only exact provider movement identifiers; numeric JSON IDs have already been preserved as strings. */
export function vtpassMovementId(
  value: unknown,
  reason:
    | 'PROVIDER_TRANSACTION_REFERENCE_INVALID'
    | 'PROVIDER_REFUND_REFERENCE_INVALID' = 'PROVIDER_TRANSACTION_REFERENCE_INVALID',
): string {
  if (
    typeof value !== 'string' ||
    value.length > 64 ||
    value.startsWith('0') ||
    !isAsciiDigits(value)
  ) {
    throw new PaymentError('INVALID_PROVIDER_EVIDENCE', { reason });
  }
  return value;
}
