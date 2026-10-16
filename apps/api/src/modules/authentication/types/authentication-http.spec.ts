/** Verify Bearer extraction preserves credentials and rejects missing, wrong-scheme and ambiguous headers. */
import { describe, expect, it } from 'vitest';
import { AuthenticationError } from '../domain/authentication-error.js';
import { readBearerToken } from './authentication-http.js';

const token = 'Ab_9-'.repeat(8) + 'XYZ';

describe('Bearer header parsing', () => {
  it.each(['Bearer', 'bearer', 'BEARER'])(
    'preserves the exact credential with the %s scheme',
    (scheme) => {
      expect(readBearerToken(`${scheme} ${token}`)).toBe(token);
    },
  );

  it.each([
    undefined,
    '',
    'Bearer',
    'Bearer ',
    `Basic ${token}`,
    ` Bearer ${token}`,
    `Bearer  ${token}`,
    `Bearer ${token} `,
    `Bearer ${token} another-token`,
    `Bearer\t${token}`,
  ])('rejects a missing or ambiguous authorization value (%j)', (header) => {
    expect(() => readBearerToken(header)).toThrow(AuthenticationError);
    expect(() => readBearerToken(header)).toThrow(
      'Unable to authenticate with the supplied credentials.',
    );
  });
});
