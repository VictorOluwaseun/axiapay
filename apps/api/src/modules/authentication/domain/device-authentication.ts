import type { AuthenticationAccount } from './authentication-models.js';
import {
  AuthenticationError,
  invalidCredentials,
} from './authentication-error.js';

/** Bound device enrollment, public challenge lifetime, and signature attempts independently of session lifetime. */
export const deviceAuthenticationPolicy = Object.freeze({
  recentAuthenticationSeconds: 300,
  challengeLifetimeSeconds: 120,
  maxAttempts: 5,
  maxActiveDevices: 5,
});

/** A verified session's authority for enrollment; legacy and device sessions carry no primary-authentication timestamp. */
export interface EnrollmentSession {
  readonly id: string;
  readonly account: AuthenticationAccount;
  readonly primaryAuthenticatedAt: Date | null;
  readonly expiresAt: Date;
}

/** A registered public key identifies one installation and account; revocation is permanent for this key. */
export interface DeviceCredential {
  readonly id: string;
  readonly accountId: string;
  readonly deviceName: string;
  readonly publicKey: string;
  readonly keyFingerprint: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
}

/** Persist the exact message to sign; enrollment additionally binds a proposed key to its initiating primary session. */
export interface DeviceChallenge {
  readonly id: string;
  readonly purpose: 'enroll' | 'login';
  readonly credentialId: string;
  readonly accountId: string | null;
  readonly enrollmentSessionId: string | null;
  readonly publicKey: string | null;
  readonly deviceName: string | null;
  readonly message: string;
  readonly expiresAt: Date;
  readonly attempts: number;
  readonly consumedAt: Date | null;
}

/** Public device management information excludes keys, account identifiers, and persistence flags. */
export function deviceIdentity(device: DeviceCredential) {
  return {
    credentialId: device.id,
    deviceName: device.deviceName,
    createdAt: device.createdAt.toISOString(),
    lastUsedAt: device.lastUsedAt?.toISOString() ?? null,
  };
}

/** Require fresh primary proof for enrollment; extending device sessions must never renew this authority. */
export function requireRecentPrimaryAuthentication(
  session: EnrollmentSession,
  now: Date,
): void {
  if (session.expiresAt.getTime() <= now.getTime()) {
    throw invalidCredentials();
  }
  const authenticatedAt = session.primaryAuthenticatedAt?.getTime();
  const ageMs =
    authenticatedAt === undefined ? Infinity : now.getTime() - authenticatedAt;
  if (
    ageMs < 0 ||
    ageMs >= deviceAuthenticationPolicy.recentAuthenticationSeconds * 1000
  ) {
    throw new AuthenticationError(
      'RECENT_AUTHENTICATION_REQUIRED',
      'Sign in with your password or a one-time code to enroll a device.',
    );
  }
}

/** Reject expired, exhausted, consumed, cross-purpose, and cross-device challenges before signature verification. */
export function canRedeemDeviceChallenge(
  challenge: DeviceChallenge | null,
  purpose: DeviceChallenge['purpose'],
  credentialId: string,
  now: Date,
): challenge is DeviceChallenge {
  return (
    challenge !== null &&
    challenge.purpose === purpose &&
    challenge.credentialId.toLowerCase() === credentialId.toLowerCase() &&
    challenge.consumedAt === null &&
    challenge.expiresAt.getTime() > now.getTime() &&
    challenge.attempts < deviceAuthenticationPolicy.maxAttempts
  );
}
