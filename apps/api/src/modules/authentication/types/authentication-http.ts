import type { AccountIdentity } from '../domain/authentication-models.js';
import { invalidCredentials } from '../domain/authentication-error.js';

/** Describe only the request fields authentication owns; proxy headers are not accepted as caller identity. */
export interface AuthenticationHttpRequest {
  readonly ip: string;
  readonly id: string;
  readonly headers: { authorization?: string };
  account?: AccountIdentity;
}
/** Minimal Fastify response contract used by transport adapters without exposing it to application code. */
export interface AuthenticationHttpResponse {
  header(name: string, value: string): this;
  status(code: number): this;
  send(body: unknown): void;
}

/** Accept exactly one opaque bearer token; cookies and query parameters do not authorize these routes. */
export function readBearerToken(authorization: string | undefined): string {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization ?? '');
  if (!match?.[1]) {
    throw invalidCredentials();
  }
  return match[1];
}
