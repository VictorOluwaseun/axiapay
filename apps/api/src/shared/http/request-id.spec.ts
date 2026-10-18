/** Exercise the correlation boundary before any request value reaches logging or response headers. */
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { assignRequestId } from './request-id.js';
import { serializeRequest } from '../../infrastructure/observability/logger-options.js';

describe('request correlation input', () => {
  it.each([
    undefined,
    '',
    'caller reference',
    'Samsung/SM',
    'caller,duplicate',
    ['first', 'second'],
    'caller\n',
    'caller\r\nInjected: value',
    '😀',
    'a'.repeat(129),
  ])(
    'replaces unsafe or ambiguous input without exposing it (%j)',
    (supplied) => {
      const socket = new Socket();
      const request = new IncomingMessage(socket);
      request.headers['x-request-id'] = supplied;
      const requestId = assignRequestId(request);
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(serializeRequest(request).id).toBe(requestId);
      socket.destroy();
    },
  );

  it.each([
    'a',
    'a'.repeat(128),
    'Samsung-SM_A556E-123-550e8400-e29b-41d4-a716-446655440000',
  ])(
    'preserves a complete safe reference for access logging (%s)',
    (supplied) => {
      const socket = new Socket();
      const request = new IncomingMessage(socket);
      request.headers['x-request-id'] = supplied;
      expect(assignRequestId(request)).toBe(supplied);
      expect(serializeRequest(request).id).toBe(supplied);
      socket.destroy();
    },
  );
});
