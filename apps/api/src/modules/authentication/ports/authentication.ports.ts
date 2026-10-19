import type {
  CodeChallenge,
  Contact,
} from '../domain/authentication-models.js';

/** Isolate password hashing and constant-work comparison for unknown or passwordless accounts. */
export interface PasswordHasher {
  /** Produce an adaptive, salted hash; raw passwords are never persisted. */
  hash(password: string): Promise<string>;
  /** Compare against the real hash or an equally expensive dummy hash when no password exists. */
  verify(password: string, hash: string | null): Promise<boolean>;
}

/** Generate unpredictable credentials and domain-separated digests without exposing implementation libraries. */
export interface AuthenticationSecrets {
  /** Generate a unique opaque request or account identifier. */
  id(): string;
  /** Generate a six-digit code with a cryptographically secure source. */
  code(): string;
  /** Generate a bearer token with at least 256 bits of entropy. */
  sessionToken(): string;
  /** Bind code verification to the challenge identifier. */
  codeDigest(challengeId: string, code: string): string;
  /** Protect low-entropy contact and IP identifiers used by rate-limit storage. */
  rateLimitKey(scope: string, identity: string): string;
  /** Hash high-entropy tokens before persistence or lookup. */
  tokenDigest(token: string): string;
  /** Compare equal-length digests without secret-dependent early exit. */
  matches(left: string, right: string): boolean;
}

/** Deliver a code through the contact's transport; throw on rejection or uncertainty, never log the code. */
export interface AuthenticationCodeDelivery {
  /** Provider acceptance is required before the stored challenge becomes redeemable. */
  send(message: {
    contact: Contact;
    purpose: CodeChallenge['purpose'];
    code: string;
    challengeId: string;
    expiresInSeconds: number;
  }): Promise<void>;
}

/** Make expiry policy deterministic in tests without importing infrastructure into services. */
export interface AuthenticationClock {
  /** Return the current UTC instant. */ now(): Date;
}

/** Share contact/IP attempt budgets across authentication workflows without coupling callers to an attempt-policy implementation. */
export interface AuthenticationAttemptLimiter {
  /** Bound credential-renewal work by IP and high-entropy proof without retaining the raw token. */
  sessionRefresh(tokenDigest: string, clientIp: string): Promise<void>;
  /** Bound enrollment attempts by authorized account and network client. */
  deviceEnrollment(accountId: string, clientIp: string): Promise<void>;
  /** Bound challenge storage by IP and opaque credential ID, including unknown credentials. */
  deviceChallenge(credentialId: string, clientIp: string): Promise<void>;
  /** Bound signature verification in addition to each challenge's durable attempt count. */
  deviceVerification(clientIp: string): Promise<void>;
  /** Consume code delivery and resend allowances; reject exhausted budgets. */
  codeRequest(contact: Contact, clientIp: string): Promise<void>;
  /** Consume password guessing allowances before expensive verification. */
  passwordLogin(contact: Contact, clientIp: string): Promise<void>;
  /** Bound challenge probing in addition to each persisted code's guess limit. */
  codeVerification(clientIp: string): Promise<void>;
}
