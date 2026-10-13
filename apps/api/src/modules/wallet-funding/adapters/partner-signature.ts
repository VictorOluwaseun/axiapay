import { createHmac, timingSafeEqual } from 'node:crypto';
import { FundingError } from '../domain/funding.js';

/** Authenticate a fixed-length hexadecimal MAC with constant-time comparison after validating its encoding. */
export function verifyPartnerSignature(
  algorithm: 'sha512' | 'sha3-512',
  secret: string,
  payload: Uint8Array | string,
  supplied: unknown,
): void {
  if (
    typeof supplied !== 'string' ||
    supplied.length !== 128 ||
    !/^[0-9a-f]+$/i.test(supplied)
  ) {
    throw new FundingError('INVALID_WEBHOOK');
  }
  const expected = createHmac(algorithm, secret).update(payload).digest();
  if (!timingSafeEqual(expected, Buffer.from(supplied, 'hex'))) {
    throw new FundingError('INVALID_WEBHOOK');
  }
}
