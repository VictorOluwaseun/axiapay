import { Catch } from '@nestjs/common';
import { HttpExceptionFilter } from '../../../shared/http/http-exception.filter.js';
import type { HttpFailure } from '../../../shared/http/http-failure.js';

/** Report configuration outages safely without exposing dependency errors or returning permissive defaults. */
@Catch()
export class RemoteConfigExceptionFilter extends HttpExceptionFilter {
  /** Project dependency failures into a stable retryable response; the shared filter handles transport errors and diagnostics. */
  protected override mapFailure(): HttpFailure {
    return {
      status: 503,
      code: 'REMOTE_CONFIG_UNAVAILABLE',
      message: 'Application configuration is temporarily unavailable.',
    };
  }
}
