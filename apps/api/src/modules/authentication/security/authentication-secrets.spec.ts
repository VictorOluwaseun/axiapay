/** Verify credential adapters use salted password hashes and domain-separated, non-reusable token digests. */
import { describe, expect, it } from 'vitest';
import { NodeAuthenticationSecrets } from './node-authentication-secrets.js';
import { ArgonPasswordHasher } from './argon-password-hasher.js';

describe('authentication credential storage', () => {
  it('binds a code digest to its challenge and deployment key', () => {
    const secrets = new NodeAuthenticationSecrets('11'.repeat(32));
    const other = new NodeAuthenticationSecrets('22'.repeat(32));
    const digest = secrets.codeDigest('one', '012345');
    expect(secrets.matches(digest, secrets.codeDigest('one', '012345'))).toBe(
      true,
    );
    expect(secrets.matches(digest, secrets.codeDigest('two', '012345'))).toBe(
      false,
    );
    expect(secrets.matches(digest, other.codeDigest('one', '012345'))).toBe(
      false,
    );
    expect(secrets.matches(digest, '00')).toBe(false);
    expect(secrets.rateLimitKey('ip', 'alice')).not.toBe(
      secrets.rateLimitKey('contact', 'alice'),
    );
  });
  it('issues unpredictable bearer tokens while persisting only their digest', () => {
    const secrets = new NodeAuthenticationSecrets('11'.repeat(32));
    const first = secrets.sessionToken();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secrets.sessionToken()).not.toBe(first);
    expect(secrets.tokenDigest(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(secrets.code()).toMatch(/^\d{6}$/);
  });
  it('uses independent Argon2id salts and never accepts a dummy-account password', async () => {
    const hasher = new ArgonPasswordHasher();
    const password = 'a longer private passphrase';
    const first = await hasher.hash(password);
    expect(first).toMatch(/^\$argon2id\$/);
    expect(await hasher.hash(password)).not.toBe(first);
    expect(await hasher.verify(password, first)).toBe(true);
    expect(await hasher.verify('incorrect', first)).toBe(false);
    expect(await hasher.verify(password, null)).toBe(false);
  });
});
