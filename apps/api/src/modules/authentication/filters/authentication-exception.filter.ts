import { Catch } from '@nestjs/common';
import { HttpExceptionFilter } from '../../../shared/http/http-exception.filter.js';
import type { HttpFailure } from '../../../shared/http/http-failure.js';
import { AuthenticationError } from '../domain/authentication-error.js';

/** Keep authentication codes and retry guidance while delegating response formatting and redacted logging to the shared HTTP boundary. */
@Catch()
export class AuthenticationExceptionFilter extends HttpExceptionFilter {
  /** Expose only domain-approved authentication messages; dependencies remain unavailable without disclosing their errors. */
  protected override mapFailure(error: unknown): HttpFailure {
    if (!(error instanceof AuthenticationError)) {
      return {
        status: 503,
        code: 'AUTHENTICATION_UNAVAILABLE',
        message: 'Authentication is temporarily unavailable.',
      };
    }
    const statuses = {
      INVALID_INPUT: 400,
      RECENT_AUTHENTICATION_REQUIRED: 403,
      DEVICE_LIMIT_REACHED: 409,
      DEVICE_ALREADY_REGISTERED: 409,
      INVALID_CREDENTIALS: 401,
      RATE_LIMITED: 429,
      DELIVERY_UNAVAILABLE: 503,
    } as const;
    return {
      status: statuses[error.code],
      code: error.code,
      message: error.message,
      ...(error.code === 'INVALID_CREDENTIALS'
        ? { authenticationScheme: 'Bearer' as const }
        : {}),
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: error.retryAfterSeconds }),
    };
  }
}
