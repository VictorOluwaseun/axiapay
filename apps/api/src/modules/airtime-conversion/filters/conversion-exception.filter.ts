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

/** Map DTO, authorization, monetary and dependency failures without leaking external payloads. */
@Catch()
export class ConversionExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ConversionExceptionFilter.name);

  /** Return bounded diagnostics and no-store responses; retryable failure never discards an accepted request or verified receipt. */
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
        .send({ code: error.code, message: 'Authentication required.' });
      return;
    }
    if (error instanceof BadRequestException) {
      response.status(400).send({
        code: 'INVALID_INPUT',
        message: 'Invalid conversion request.',
      });
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
        .send({ code: error.code, message: 'Invalid conversion terms.' });
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
        message:
          'Credit cannot be applied. Keep the original conversion and contact support.',
      });
      return;
    }
    const code =
      error instanceof ConversionError ? error.code : 'CONVERSION_UNAVAILABLE';
    const failure = failures[code];
    this.logger.warn({
      event: 'airtime_conversion_request_failed',
      requestId: host.switchToHttp().getRequest<AuthenticationHttpRequest>().id,
      code,
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
    response.status(failure.status).send({ code, message: failure.message });
  }
}
