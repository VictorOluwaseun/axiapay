import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import {
  readBearerToken,
  type AuthenticationHttpRequest,
} from '../types/authentication-http.js';

/** Reuse the guard's token or extract it for unguarded logout; services retain session policy and authorization. */
export const BearerToken = createParamDecorator(
  (_input: unknown, context: ExecutionContext): string => {
    const request = context
      .switchToHttp()
      .getRequest<AuthenticationHttpRequest>();
    return (
      request.bearerToken ?? readBearerToken(request.headers.authorization)
    );
  },
);
