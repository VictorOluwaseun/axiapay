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
import { WalletError } from '../../wallets/domain/wallet-error.js';
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

/** Cover authentication, DTO, monetary and dependency failures for customer and webhook delivery boundaries. */
@Catch()
export class FundingExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(FundingExceptionFilter.name);

  /** Return retryable failures until financial commit; HTTP success must never acknowledge an unposted valid payment. */
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host
      .switchToHttp()
      .getResponse<AuthenticationHttpResponse>();
    response.header('Cache-Control', 'no-store');
    if (
      error instanceof AuthenticationError &&
      error.code === 'INVALID_CREDENTIALS'
    ) {
      response
        .header('WWW-Authenticate', 'Bearer')
        .status(401)
        .send({ code: error.code, message: error.message });
      return;
    }
    if (error instanceof BadRequestException) {
      response
        .status(400)
        .send({ code: 'INVALID_INPUT', message: 'Invalid funding request.' });
      return;
    }
    if (
      error instanceof AuthenticationError &&
      error.code === 'INVALID_INPUT'
    ) {
      response
        .status(400)
        .send({ code: 'INVALID_INPUT', message: 'Invalid funding contact.' });
      return;
    }
    if (
      error instanceof WalletError &&
      ['FORBIDDEN', 'WALLET_NOT_FOUND'].includes(error.code)
    ) {
      response
        .status(404)
        .send({ code: 'WALLET_NOT_FOUND', message: 'Wallet not found.' });
      return;
    }
    if (
      error instanceof WalletError &&
      ['INVALID_AMOUNT', 'INVALID_CURRENCY', 'INVALID_REFERENCE'].includes(
        error.code,
      )
    ) {
      response
        .status(400)
        .send({ code: error.code, message: 'Invalid funding terms.' });
      return;
    }
    if (
      error instanceof WalletError &&
      [
        'WALLET_RESTRICTED',
        'CURRENCY_MISMATCH',
        'IDEMPOTENCY_CONFLICT',
      ].includes(error.code)
    ) {
      response.status(409).send({
        code: error.code,
        message: 'Funding cannot be applied to this wallet.',
      });
      return;
    }
    const code =
      error instanceof FundingError ? error.code : 'FUNDING_UNAVAILABLE';
    const failure = fundingFailures[code];
    if (failure.status !== 401) {
      this.logger.warn({
        event: 'funding_request_failed',
        requestId: host.switchToHttp().getRequest<AuthenticationHttpRequest>()
          .id,
        code,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
    }
    response.status(failure.status).send({ code, message: failure.message });
  }
}
