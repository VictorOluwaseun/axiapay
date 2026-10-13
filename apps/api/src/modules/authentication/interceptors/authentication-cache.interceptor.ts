import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { AuthenticationHttpResponse } from '../types/authentication-http.js';

/** Prevent intermediary or client caches from storing tokens, identities, or authentication results. */
@Injectable()
export class AuthenticationCacheInterceptor implements NestInterceptor {
  /** Apply cache policy to every authentication response before delegating to its handler. */
  intercept(context: ExecutionContext, next: CallHandler) {
    context
      .switchToHttp()
      .getResponse<AuthenticationHttpResponse>()
      .header('Cache-Control', 'no-store')
      .header('Pragma', 'no-cache');
    return next.handle();
  }
}
