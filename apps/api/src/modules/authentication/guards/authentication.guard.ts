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

/** Resolve current session state before protected handlers execute; business permissions remain in the relevant service operations. */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  /** Inject the application query rather than accessing a repository or token library. */
  constructor(
    @Inject(AuthenticationService)
    private readonly authentication: AuthenticationService,
  ) {}
  /** Attach the verified caller identity for the lifetime of this request only. */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<AuthenticationHttpRequest>();
    request.account = await this.authentication.authenticate(
      readBearerToken(request.headers.authorization),
    );
    return true;
  }
}
