/** Exercise canonical identity, password bounds, and code state policy independently of frameworks. */
import { describe, expect, it } from 'vitest';
import {
  canRedeemChallenge,
  normalizeContact,
  validateNewPassword,
} from './authentication-policy.js';
import type { CodeChallenge } from './authentication-models.js';

describe('authentication policy', () => {
  it('normalizes email casing without changing mailbox aliases', () => {
    expect(
      normalizeContact({ kind: 'email', value: ' Alice+Home@Example.COM ' }),
    ).toEqual({ kind: 'email', value: 'alice+home@example.com' });
  });
  it('requires an international phone number rather than guessing a country', () => {
    expect(
      normalizeContact({ kind: 'phone', value: ' +2348012345678 ' }).value,
    ).toBe('+2348012345678');
    expect(() =>
      normalizeContact({ kind: 'phone', value: '08012345678' }),
    ).toThrow();
    expect(() => normalizeContact({ kind: 'phone', value: '+123' })).toThrow();
  });
  it.each([
    'alice',
    'alice@',
    'alice@localhost',
    'a..b@example.com',
    '.alice@example.com',
    'alice\n@example.com',
  ])('rejects invalid email %s', (value) => {
    expect(() => normalizeContact({ kind: 'email', value })).toThrow();
  });
  it('allows Unicode and spaces while enforcing passphrase length', () => {
    expect(() =>
      validateNewPassword('a long private passphrase'),
    ).not.toThrow();
    expect(() => validateNewPassword('🔐'.repeat(128))).not.toThrow();
    expect(() => validateNewPassword('short')).toThrow();
    expect(() => validateNewPassword('a'.repeat(129))).toThrow();
  });
  it('rejects expiry at the exact boundary, exhausted attempts, wrong purposes, and terminal states', () => {
    const now = new Date('2030-01-01T00:00:00Z');
    const challenge: CodeChallenge = {
      id: 'id',
      purpose: 'signup',
      contact: { kind: 'email', value: 'alice@example.com' },
      passwordHash: null,
      codeDigest: 'digest',
      createdAt: now,
      expiresAt: new Date(now.getTime() + 1),
      attempts: 0,
      status: 'ready',
    };
    expect(canRedeemChallenge(challenge, 'signup', now)).toBe(true);
    expect(
      canRedeemChallenge({ ...challenge, expiresAt: now }, 'signup', now),
    ).toBe(false);
    expect(
      canRedeemChallenge({ ...challenge, attempts: 5 }, 'signup', now),
    ).toBe(false);
    expect(canRedeemChallenge(challenge, 'login', now)).toBe(false);
    for (const status of ['pending', 'consumed', 'invalidated'] as const) {
      expect(canRedeemChallenge({ ...challenge, status }, 'signup', now)).toBe(
        false,
      );
    }
  });
});
