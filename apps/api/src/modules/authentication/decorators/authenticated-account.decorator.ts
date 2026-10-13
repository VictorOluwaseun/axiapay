import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { invalidCredentials } from '../domain/authentication-error.js';
import type { AccountIdentity } from '../domain/authentication-models.js';
import type { AuthenticationHttpRequest } from '../types/authentication-http.js';

/** Read only the identity established by AuthenticationGuard; missing guard context fails closed. */
export const AuthenticatedAccount = createParamDecorator(
  (_input: unknown, context: ExecutionContext): AccountIdentity => {
    const { account } = context
      .switchToHttp()
      .getRequest<AuthenticationHttpRequest>();
    if (!account) {
      throw invalidCredentials();
    }
    return account;
  },
);
