import {
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { AuthenticationService } from '../services/authentication.service.js';
import {
  readBearerToken,
  type AuthenticationHttpRequest,
} from '../types/authentication-http.js';

/** Require current PostgreSQL identity for protected mutations; read-only requests may use Redis. Business permissions remain in services. */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  /** Inject the application query rather than accessing a repository or token library. */
  constructor(
    @Inject(AuthenticationService)
    private readonly authentication: AuthenticationService,
  ) {}
  /** Attach the verified caller identity and its Bearer token for the lifetime of this request only. */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<AuthenticationHttpRequest>();
    const token = readBearerToken(request.headers.authorization);
    const requireCurrentState = !['GET', 'HEAD', 'OPTIONS'].includes(
      request.method,
    );
    request.account = await this.authentication.authenticate(
      token,
      requireCurrentState,
    );
    request.bearerToken = token;
    return true;
  }
}
