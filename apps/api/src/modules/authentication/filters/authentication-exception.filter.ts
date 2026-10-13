import {
  BadRequestException,
  Catch,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { AuthenticationError } from '../domain/authentication-error.js';
import type {
  AuthenticationHttpRequest,
  AuthenticationHttpResponse,
} from '../types/authentication-http.js';

/** Map explicit failures to safe HTTP responses and retain request-correlated, redacted dependency diagnostics. */
@Catch()
export class AuthenticationExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AuthenticationExceptionFilter.name);
  /** Never serialize provider errors, SQL parameters, passwords, or submitted codes into public responses or logs. */
  catch(error: unknown, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<AuthenticationHttpRequest>();
    const response = host
      .switchToHttp()
      .getResponse<AuthenticationHttpResponse>();
    response.header('Cache-Control', 'no-store');
    if (error instanceof BadRequestException) {
      response
        .status(400)
        .send({ code: 'INVALID_INPUT', message: 'Invalid request body.' });
      return;
    }
    if (!(error instanceof AuthenticationError)) {
      this.logger.error({
        event: 'authentication_dependency_failed',
        requestId: request.id,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      response.status(503).send({
        code: 'AUTHENTICATION_UNAVAILABLE',
        message: 'Authentication is temporarily unavailable.',
      });
      return;
    }
    if (error.code === 'DELIVERY_UNAVAILABLE')
      this.logger.warn({
        event: 'authentication_delivery_failed',
        requestId: request.id,
        causeType:
          error.cause instanceof Error ? error.cause.name : 'UnknownError',
      });
    const statuses = {
      INVALID_INPUT: 400,
      INVALID_CREDENTIALS: 401,
      RATE_LIMITED: 429,
      DELIVERY_UNAVAILABLE: 503,
    } as const;
    if (error.retryAfterSeconds)
      response.header('Retry-After', String(error.retryAfterSeconds));
    response.status(statuses[error.code]).send({
      code: error.code,
      message: error.message,
      ...(error.retryAfterSeconds
        ? { retryAfterSeconds: error.retryAfterSeconds }
        : {}),
    });
  }
}
