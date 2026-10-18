import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Http2ServerRequest } from 'node:http2';

/** Accept a bounded diagnostic label only; request IDs never establish identity, uniqueness, or payment consent. */
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Validate caller correlation before Fastify or Pino can log it, falling back without rejecting the request. */
export function assignRequestId(
  request: IncomingMessage | Http2ServerRequest,
): string {
  const supplied = request.headers['x-request-id'];
  const requestId =
    typeof supplied === 'string' &&
    supplied.match(requestIdPattern)?.[0] === supplied
      ? supplied
      : randomUUID();
  Object.assign(request, { id: requestId });
  return requestId;
}
