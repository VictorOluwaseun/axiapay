import type { AxiosInstance, AxiosRequestConfig } from 'axios';
import {
  isOutboundResponseTooLarge,
  OutboundHttpError,
} from '@axiapay/payments-runtime/infrastructure/http/axios-client';
import { FundingError } from '../domain/funding.js';

/** Parse JSON integer tokens as exact strings, including provider IDs beyond JavaScript's safe-integer range (Node 24). */
export function parsePartnerJson(text: string): unknown {
  try {
    return JSON.parse(
      text,
      (_key: string, value: unknown, context?: { source: string }) => {
        if (
          typeof value === 'number' &&
          context &&
          /^(0|[1-9][0-9]*)$/.test(context.source)
        ) {
          return context.source;
        }
        return value;
      },
    );
  } catch (cause) {
    throw new FundingError('INVALID_FUNDING', { cause });
  }
}

/** Require a JSON object without allowing arrays, null, or implicit string conversion. */
export function partnerObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FundingError('INVALID_FUNDING');
  }
  return value as Record<string, unknown>;
}

/** Accept nonempty bounded partner identifiers; caller policy validates protocol-specific syntax. */
export function partnerString(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    value.trim() !== value ||
    value.includes('\u0000')
  ) {
    throw new FundingError('INVALID_FUNDING');
  }
  return value;
}

/** Convert only canonical positive integer strings; parsePartnerJson retains number tokens before any rounding can occur. */
export function partnerInteger(value: unknown): bigint {
  const text = partnerString(value);
  if (!/^[1-9][0-9]{0,19}(?![\s\S])/.test(text)) {
    throw new FundingError('INVALID_FUNDING');
  }
  return BigInt(text);
}

/** Preserve opaque decimal payment IDs as strings; OPay order numbers can exceed both bigint money and uint64 ranges. */
export function partnerMovementId(value: unknown): string {
  const identifier = partnerString(value);
  if (!/^[1-9][0-9]{0,99}(?![\s\S])/.test(identifier)) {
    throw new FundingError('INVALID_FUNDING');
  }
  return identifier;
}

/** Accept hosted checkout URLs only on the selected partner's HTTPS origin family; never return credentials or arbitrary redirects. */
export function partnerCheckoutUrl(
  value: unknown,
  partner: 'opay' | 'paystack',
): string {
  if (typeof value !== 'string' || value.length > 4096) {
    throw new FundingError('INVALID_FUNDING');
  }
  const url = new URL(value);
  const allowed =
    partner === 'paystack'
      ? url.hostname === 'checkout.paystack.com'
      : url.hostname.endsWith('.opaycheckout.com');
  if (
    !allowed ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new FundingError('INVALID_FUNDING');
  }
  return value;
}

/** Call a fixed partner endpoint once with a bounded deadline, no redirects, and redacted error context. */
export async function requestPartnerJson(
  client: AxiosInstance,
  url: string,
  options: Pick<AxiosRequestConfig<string>, 'method' | 'data' | 'headers'>,
): Promise<Record<string, unknown>> {
  try {
    const response = await client.request<string>({
      url,
      ...options,
    });
    return partnerObject(parsePartnerJson(response.data));
  } catch (cause) {
    if (cause instanceof FundingError) {
      throw cause;
    }
    if (isOutboundResponseTooLarge(cause)) {
      throw new FundingError('INVALID_FUNDING');
    }
    // Only the interceptor's controlled classification is safe to retain; other exceptions may contain signed bodies or credentials.
    throw new FundingError('FUNDING_UNAVAILABLE', {
      cause:
        cause instanceof OutboundHttpError
          ? cause
          : new Error('Funding provider HTTP request failed or timed out.'),
    });
  }
}
