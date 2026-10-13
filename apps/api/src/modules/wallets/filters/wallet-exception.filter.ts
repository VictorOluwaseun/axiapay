import {
  BadRequestException,
  Catch,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { AuthenticationError } from '../../authentication/domain/authentication-error.js';
import type {
  AuthenticationHttpRequest,
  AuthenticationHttpResponse,
} from '../../authentication/types/authentication-http.js';
import { WalletError } from '../domain/wallet-error.js';

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

/** Translate wallet and session failures while keeping sensitive financial responses out of caches and logs. */
@Catch()
export class WalletExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(WalletExceptionFilter.name);

  /** Guard failures are handled here too; uncertain dependency outcomes never become confirmed transfer failures. */
  catch(error: unknown, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<AuthenticationHttpRequest>();
    const response = host
      .switchToHttp()
      .getResponse<AuthenticationHttpResponse>();
    response.header('Cache-Control', 'no-store').header('Pragma', 'no-cache');
    if (
      error instanceof AuthenticationError &&
      error.code === 'INVALID_CREDENTIALS'
    ) {
      response.header('WWW-Authenticate', 'Bearer').status(401).send({
        code: error.code,
        message: error.message,
      });
      return;
    }
    if (error instanceof BadRequestException) {
      response
        .status(400)
        .send({ code: 'INVALID_INPUT', message: 'Invalid request.' });
      return;
    }
    const failure =
      error instanceof WalletError ? walletFailures[error.code] : undefined;
    if (failure) {
      response
        .status(failure.status)
        .send({ code: failure.code, message: failure.message });
      return;
    }
    this.logger.error({
      event: 'wallet_request_unavailable',
      requestId: request.id,
      errorType: error instanceof Error ? error.name : 'UnknownError',
      walletErrorCode: error instanceof WalletError ? error.code : undefined,
    });
    response.status(503).send({
      code: 'WALLET_UNAVAILABLE',
      message:
        'Wallet operation unavailable. Retry transfers with the same request key and terms.',
    });
  }
}
