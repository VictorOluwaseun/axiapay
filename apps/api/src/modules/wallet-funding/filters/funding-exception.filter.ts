import { Catch } from '@nestjs/common';
import { HttpExceptionFilter } from '../../../shared/http/http-exception.filter.js';
import type { HttpFailure } from '../../../shared/http/http-failure.js';
import { AuthenticationError } from '../../authentication/domain/authentication-error.js';
import { WalletError } from '@axiapay/backend/modules/wallets/domain/wallet-error';
import { FundingError } from '../domain/funding.js';

/** Stable funding errors never expose raw partner responses, signed payloads, email addresses, or credentials. */
const fundingFailures = {
  FUNDING_UNAVAILABLE: {
    status: 503,
    message:
      'Funding outcome may be uncertain. Keep the original request key and reconcile.',
  },
  FUNDING_NOT_FOUND: { status: 404, message: 'Funding request not found.' },
  FUNDING_CONFLICT: {
    status: 409,
    message:
      'Funding identity conflicts with previously recorded terms or payment.',
  },
  INVALID_FUNDING: {
    status: 400,
    message: 'Funding terms or verified partner evidence do not match.',
  },
  INVALID_WEBHOOK: { status: 401, message: 'Invalid partner notification.' },
  FUNDING_UNCONFIRMED: {
    status: 409,
    message: 'The partner has not confirmed successful funding.',
  },
} as const;

/** Project customer and partner funding errors; shared handling owns response envelopes, headers, and diagnostics. */
@Catch()
export class FundingExceptionFilter extends HttpExceptionFilter {
  /** Preserve partner authentication and uncertain funding semantics without acknowledging an unposted payment. */
  protected override mapFailure(error: unknown): HttpFailure {
    if (
      error instanceof AuthenticationError &&
      error.code === 'INVALID_CREDENTIALS'
    ) {
      return {
        status: 401,
        code: error.code,
        message: error.message,
        authenticationScheme: 'Bearer',
      };
    }
    if (
      error instanceof AuthenticationError &&
      error.code === 'INVALID_INPUT'
    ) {
      return {
        status: 400,
        code: 'INVALID_INPUT',
        message: 'Invalid funding contact.',
      };
    }
    if (
      error instanceof WalletError &&
      ['FORBIDDEN', 'WALLET_NOT_FOUND'].includes(error.code)
    ) {
      return {
        status: 404,
        code: 'WALLET_NOT_FOUND',
        message: 'Wallet not found.',
      };
    }
    if (
      error instanceof WalletError &&
      ['INVALID_AMOUNT', 'INVALID_CURRENCY', 'INVALID_REFERENCE'].includes(
        error.code,
      )
    ) {
      return {
        status: 400,
        code: error.code,
        message: 'Invalid funding terms.',
      };
    }
    if (
      error instanceof WalletError &&
      [
        'WALLET_RESTRICTED',
        'CURRENCY_MISMATCH',
        'IDEMPOTENCY_CONFLICT',
      ].includes(error.code)
    ) {
      return {
        status: 409,
        code: error.code,
        message: 'Funding cannot be applied to this wallet.',
      };
    }
    const code =
      error instanceof FundingError ? error.code : 'FUNDING_UNAVAILABLE';
    return { ...fundingFailures[code], code };
  }
}
