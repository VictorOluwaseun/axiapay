import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { AuthenticationSecrets } from '../ports/authentication.ports.js';

/** Use Node cryptography for random secrets and keyed low-entropy digests; the key must persist across restarts. */
export class NodeAuthenticationSecrets implements AuthenticationSecrets {
  /** Receive a validated 256-bit secret from configuration, never from a source-code default. */
  constructor(private readonly secret: string) {}
  /** Allocate an unpredictable identifier for an account, challenge, or session. */
  id(): string {
    return randomUUID();
  }
  /** Preserve leading zeroes while sampling all six-digit codes uniformly. */
  code(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, '0');
  }
  /** Generate a fresh 256-bit bearer token for each successful login. */
  sessionToken(): string {
    return randomBytes(32).toString('base64url');
  }
  /** Bind a code to its challenge so a matching code from another request cannot be reused. */
  codeDigest(challengeId: string, code: string): string {
    return this.keyedDigest(['code', challengeId, code]);
  }
  /** Hide canonical contacts and IPs in rate-limit keys using a separate digest namespace. */
  rateLimitKey(scope: string, identity: string): string {
    return this.keyedDigest(['rate', scope, identity]);
  }
  /** Hash already-unpredictable session tokens for durable lookup without storing bearer credentials. */
  tokenDigest(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
  /** Avoid variable-time equality for stored OTP digests. */
  matches(left: string, right: string): boolean {
    const expected = Buffer.from(left, 'hex');
    const actual = Buffer.from(right, 'hex');
    if (expected.length !== actual.length) {
      return false;
    }
    return timingSafeEqual(expected, actual);
  }
  /** Encode the digest context unambiguously before applying the secret key. */
  private keyedDigest(parts: string[]): string {
    return createHmac('sha256', Buffer.from(this.secret, 'hex'))
      .update(JSON.stringify(parts))
      .digest('hex');
  }
}
