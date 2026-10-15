/** Exercise authoritative code state policy independently of transport and validation frameworks. */
import { describe, expect, it } from 'vitest';
import { canRedeemChallenge } from './authentication-policy.js';
import type { CodeChallenge } from './authentication-models.js';

describe('authentication policy', () => {
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
