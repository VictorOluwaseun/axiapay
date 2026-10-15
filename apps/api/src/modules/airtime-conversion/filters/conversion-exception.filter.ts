import { Catch } from '@nestjs/common';
import { HttpExceptionFilter } from '../../../shared/http/http-exception.filter.js';
import type { HttpFailure } from '../../../shared/http/http-failure.js';
import { AuthenticationError } from '../../authentication/domain/authentication-error.js';
import { WalletError } from '../../wallets/domain/wallet-error.js';
import { ConversionError } from '../domain/conversion.js';

/** Stable customer errors omit provider messages, source phones, evidence and credentials. */
const failures = {
  CONVERSION_UNAVAILABLE: {
    status: 503,
    message:
      'Keep the original conversion identity and reconcile. The outcome may be uncertain.',
  },
  CONVERSION_NOT_FOUND: {
    status: 404,
    message: 'Conversion or quote not found.',
  },
  CONVERSION_CONFLICT: {
    status: 409,
    message:
      'Conversion identity or evidence conflicts. Check the original conversion or contact support.',
  },
  INVALID_CONVERSION: {
    status: 400,
    message: 'Invalid conversion terms or evidence.',
  },
  AIRTIME_INELIGIBLE: {
    status: 422,
    message: 'This airtime is not eligible for the selected offer.',
  },
  QUOTE_EXPIRED: {
    status: 409,
    message: 'Review a fresh quote before accepting.',
  },
  CONVERSION_TERMS_CHANGED: {
    status: 409,
    message: 'The offer changed or was withdrawn. Review a fresh quote.',
  },
} as const;

/** Supply conversion-specific safe projections; shared handling owns response delivery, headers, and diagnostics. */
@Catch()
export class ConversionExceptionFilter extends HttpExceptionFilter {
  /** Preserve accepted conversion identities and receipts when dependencies fail or credit needs recovery. */
  protected override mapFailure(error: unknown): HttpFailure {
    if (
      error instanceof AuthenticationError &&
      error.code === 'INVALID_CREDENTIALS'
    ) {
      return {
        status: 401,
        code: error.code,
        message: 'Authentication required.',
        authenticationScheme: 'Bearer',
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
        message: 'Invalid conversion terms.',
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
        message:
          'Credit cannot be applied. Keep the original conversion and contact support.',
      };
    }
    const code =
      error instanceof ConversionError ? error.code : 'CONVERSION_UNAVAILABLE';
    return { ...failures[code], code };
  }
}
