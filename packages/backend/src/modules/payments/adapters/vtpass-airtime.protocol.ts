import { PaymentError, type ServicePayment } from '../domain/payment.js';
import { maximumMinorUnits } from '../../wallets/domain/money.js';

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
  if (typeof value !== 'string') {
    throw new PaymentError('INVALID_PROVIDER_EVIDENCE', {
      reason: 'PROVIDER_AMOUNT_INVALID',
    });
  }
  const match = /^(0|[1-9][0-9]{0,16})(?:\.([0-9]{1,2}))?(?![\s\S])/.exec(
    value,
  );
  if (!match) {
    throw new PaymentError('INVALID_PROVIDER_EVIDENCE', {
      reason: 'PROVIDER_AMOUNT_INVALID',
    });
  }
  const amount =
    BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  if (amount <= 0n || amount > maximumMinorUnits) {
    throw new PaymentError('INVALID_PROVIDER_EVIDENCE', {
      reason: 'PROVIDER_AMOUNT_OUT_OF_RANGE',
    });
  }
  return amount;
}

/** Guard object-shaped upstream records without coercing null, arrays or primitives. */
export function vtpassObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
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

/** Parse and canonicalize the exact decimal into the provider's numeric amount; only JSON-escaped strings and a checked numeric token enter the body. */
export function serializeVtpassAirtime(request: VtpassAirtimeRequest): string {
  const amountMinorUnits = vtpassMinorUnits(request.amount);
  const amount = formatVtpassNaira(amountMinorUnits);
  return `{"request_id":${JSON.stringify(request.request_id)},"serviceID":${JSON.stringify(request.serviceID)},"amount":${amount},"phone":${JSON.stringify(request.phone)}}`;
}

/** Accept only exact provider movement identifiers; numeric JSON IDs have already been preserved as strings. */
export function vtpassMovementId(
  value: unknown,
  reason:
    | 'PROVIDER_TRANSACTION_REFERENCE_INVALID'
    | 'PROVIDER_REFUND_REFERENCE_INVALID' = 'PROVIDER_TRANSACTION_REFERENCE_INVALID',
): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,63}(?![\s\S])/.test(value)) {
    throw new PaymentError('INVALID_PROVIDER_EVIDENCE', { reason });
  }
  return value;
}
