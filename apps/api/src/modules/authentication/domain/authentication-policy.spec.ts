/** Exercise authoritative code state policy independently of transport and validation frameworks. */
import { describe, expect, it } from 'vitest';
import {
  canRedeemChallenge,
  matchesChallengeAccount,
} from './authentication-policy.js';
import type { CodeChallenge } from './authentication-models.js';

describe('authentication policy', () => {
  it('rejects expiry at the exact boundary, exhausted attempts, wrong purposes, and terminal states', () => {
    const now = new Date('2030-01-01T00:00:00Z');
    const challenge: CodeChallenge = {
      id: 'id',
      purpose: 'signup',
      accountId: null,
      credentialVersion: null,
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

describe('code identity versions', () => {
  it('rejects disabled, substituted, and pre-recovery identities', () => {
    const now = new Date();
    const account = {
      id: 'owner',
      contact: { kind: 'email' as const, value: 'alice@example.com' },
      credentialVersion: 1,
      passwordHash: null,
      createdAt: now,
      verifiedAt: now,
      disabledAt: null,
    };
    const challenge: CodeChallenge = {
      id: 'proof',
      purpose: 'password-reset',
      accountId: account.id,
      credentialVersion: account.credentialVersion,
      contact: account.contact,
      codeDigest: 'digest',
      passwordHash: null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 300_000),
      status: 'ready',
      attempts: 0,
    };
    expect(matchesChallengeAccount(challenge, account)).toBe(true);
    expect(
      matchesChallengeAccount({ ...challenge, credentialVersion: 0 }, account),
    ).toBe(false);
    expect(
      matchesChallengeAccount(
        { ...challenge, accountId: null, credentialVersion: null },
        account,
      ),
    ).toBe(false);
    expect(
      matchesChallengeAccount(challenge, { ...account, id: 'other' }),
    ).toBe(false);
    expect(
      matchesChallengeAccount(challenge, { ...account, disabledAt: now }),
    ).toBe(false);
  });
});
