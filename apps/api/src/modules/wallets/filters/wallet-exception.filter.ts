import { Catch } from '@nestjs/common';
import { HttpExceptionFilter } from '../../../shared/http/http-exception.filter.js';
import type { HttpFailure } from '../../../shared/http/http-failure.js';
import { AuthenticationError } from '../../authentication/domain/authentication-error.js';
import { WalletError } from '@axiapay/payments-runtime/modules/wallets/domain/wallet-error';

/** Public failures are deliberately narrower than internal ledger and integration failures. */
const walletFailures: Partial<
  Record<WalletError['code'], { status: number; code: string; message: string }>
> = {
  INVALID_AMOUNT: {
    status: 400,
    code: 'INVALID_AMOUNT',
    message: 'Invalid amount in minor units.',
  },
  INVALID_CURRENCY: {
    status: 400,
    code: 'INVALID_CURRENCY',
    message: 'Invalid currency.',
  },
  INVALID_REFERENCE: {
    status: 400,
    code: 'INVALID_REFERENCE',
    message: 'Invalid request reference.',
  },
  INVALID_TRANSFER: {
    status: 400,
    code: 'INVALID_TRANSFER',
    message: 'Source and destination wallets must differ.',
  },
  WALLET_NOT_FOUND: {
    status: 404,
    code: 'WALLET_NOT_FOUND',
    message: 'Wallet not found.',
  },
  // Do not disclose whether an inaccessible source wallet exists.
  FORBIDDEN: {
    status: 404,
    code: 'WALLET_NOT_FOUND',
    message: 'Wallet not found.',
  },
  WALLET_RESTRICTED: {
    status: 409,
    code: 'WALLET_RESTRICTED',
    message: 'A wallet is restricted.',
  },
  CURRENCY_MISMATCH: {
    status: 409,
    code: 'CURRENCY_MISMATCH',
    message: 'Wallet currencies must match the transfer currency.',
  },
  INSUFFICIENT_FUNDS: {
    status: 409,
    code: 'INSUFFICIENT_FUNDS',
    message: 'Insufficient available funds.',
  },
  IDEMPOTENCY_CONFLICT: {
    status: 409,
    code: 'IDEMPOTENCY_CONFLICT',
    message: 'Request key already used with different terms.',
  },
};

/** Project wallet and session failures; shared handling owns headers, error envelopes, and diagnostics. */
@Catch()
export class WalletExceptionFilter extends HttpExceptionFilter {
  /** Preserve wallet privacy and uncertain transfer guidance rather than reporting a confirmed financial failure. */
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
    const failure =
      error instanceof WalletError ? walletFailures[error.code] : undefined;
    if (failure) {
      return failure;
    }
    return {
      status: 503,
      code: 'WALLET_UNAVAILABLE',
      message:
        'Wallet operation unavailable. Retry transfers with the same request key and terms.',
    };
  }
}
