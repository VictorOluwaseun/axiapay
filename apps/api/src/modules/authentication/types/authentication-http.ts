import type { AccountIdentity } from '../domain/authentication-models.js';
import { invalidCredentials } from '../domain/authentication-error.js';

/** Describe only the request fields authentication owns; proxy headers are not accepted as caller identity. */
export interface AuthenticationHttpRequest {
  readonly method: string;
  readonly ip: string;
  readonly id: string;
  readonly headers: { authorization?: string };
  /** The guard attaches this only after successful authentication, for reuse within this request. */
  bearerToken?: string;
  account?: AccountIdentity;
}
/** Minimal Fastify response contract used by transport adapters without exposing it to application code. */
export interface AuthenticationHttpResponse {
  header(name: string, value: string): this;
  status(code: number): this;
  send(body: unknown): void;
}

/** Read exactly one Bearer credential; the authentication service verifies its session. */
export function readBearerToken(authorization: string | undefined): string {
  const authorizationParts = authorization?.split(' ') ?? [];
  const token = authorizationParts[1];
  if (
    authorizationParts.length !== 2 ||
    authorizationParts[0]?.toLowerCase() !== 'bearer' ||
    !token
  ) {
    throw invalidCredentials();
  }
  return token;
}
