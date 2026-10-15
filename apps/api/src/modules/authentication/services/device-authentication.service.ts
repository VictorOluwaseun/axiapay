import { Inject, Injectable } from '@nestjs/common';
import { AUTHENTICATION } from '../authentication.tokens.js';
import {
  AuthenticationError,
  invalidCredentials,
} from '../domain/authentication-error.js';
import {
  canRedeemDeviceChallenge,
  deviceAuthenticationPolicy,
  deviceIdentity,
  requireRecentPrimaryAuthentication,
  type DeviceChallenge,
  type DeviceCredential,
} from '../domain/device-authentication.js';
import type { AuthenticationRepository } from '../repositories/contracts/authentication.repository.js';
import type { DeviceAuthenticationRepository } from '../repositories/contracts/device-authentication.repository.js';
import type {
  AuthenticationClock,
  AuthenticationSecrets,
  AuthenticationAttemptLimiter,
} from '../ports/authentication.ports.js';
import type { DeviceSignatures } from '../ports/device-signatures.js';
import { AuthenticationRateLimiter } from './authentication-rate-limiter.service.js';
import { AuthenticationService } from './authentication.service.js';
import { issueSession } from './authentication-session.js';

/** Bound proof inputs contain only server-issued identifiers and a signature, never caller-selected ownership or purpose. */
export interface DeviceProof {
  readonly challengeId: string;
  readonly credentialId: string;
  readonly signature: string;
  readonly clientIp: string;
}

/** Own verified enrollment, one-use device login, and account-scoped revocation; storage and cryptography stay behind ports. */
@Injectable()
export class DeviceAuthenticationService {
  /** Inject cohesive authentication collaborators and independent persistence/crypto capabilities. */
  constructor(
    @Inject(AUTHENTICATION.devices)
    private readonly devices: DeviceAuthenticationRepository,
    @Inject(AUTHENTICATION.deviceSignatures)
    private readonly signatures: DeviceSignatures,
    @Inject(AUTHENTICATION.secrets)
    private readonly secrets: AuthenticationSecrets,
    @Inject(AUTHENTICATION.clock) private readonly clock: AuthenticationClock,
    @Inject(AuthenticationRateLimiter)
    private readonly limiter: AuthenticationAttemptLimiter,
    @Inject(AuthenticationService)
    private readonly authentication: AuthenticationService,
  ) {}

  /** Bind a proposed key to a fresh primary session; possession is proved separately before it becomes a login credential. */
  async requestEnrollment(
    token: string,
    input: { publicKey: string; deviceName: string; clientIp: string },
  ) {
    const owner = await this.authentication.authenticate(token);
    await this.limiter.deviceEnrollment(owner.id, input.clientIp);
    const { publicKey } = this.signatures.readPublicKey(input.publicKey);
    return this.devices.transaction(async (devices, authentication) => {
      const now = this.clock.now();
      const session = await this.enrollmentSession(authentication, token, now);
      await this.requireDeviceCapacity(devices, session.account.id);
      const challenge = this.newChallenge('enroll', this.secrets.id(), now, {
        accountId: session.account.id,
        enrollmentSessionId: session.id,
        publicKey,
        deviceName: input.deviceName,
      });
      await devices.storeChallenge(challenge);
      return this.challengeResponse(challenge);
    });
  }

  /** Recheck primary authority and exact enrollment binding; account locking enforces the device limit under concurrency. */
  async verifyEnrollment(token: string, input: DeviceProof) {
    await this.limiter.deviceVerification(input.clientIp);
    const result = await this.devices.transaction(
      async (devices, authentication) => {
        const session = await this.enrollmentSession(
          authentication,
          token,
          this.clock.now(),
        );
        const challenge = await devices.lockChallenge(input.challengeId);
        // Lock waits must not extend enrollment authority or a challenge deadline.
        const now = this.clock.now();
        requireRecentPrimaryAuthentication(session, now);
        if (
          !canRedeemDeviceChallenge(
            challenge,
            'enroll',
            input.credentialId,
            now,
          )
        ) {
          return null;
        }
        if (
          challenge.accountId !== session.account.id ||
          challenge.enrollmentSessionId !== session.id ||
          !challenge.publicKey ||
          !challenge.deviceName
        ) {
          return null;
        }
        if (
          !this.signatures.verify(
            challenge.publicKey,
            challenge.message,
            input.signature,
          )
        ) {
          return this.rejectProof(devices, challenge.id);
        }
        await this.requireDeviceCapacity(devices, session.account.id);
        const { fingerprint } = this.signatures.readPublicKey(
          challenge.publicKey,
        );
        const device: DeviceCredential = {
          id: challenge.credentialId,
          accountId: session.account.id,
          deviceName: challenge.deviceName,
          publicKey: challenge.publicKey,
          keyFingerprint: fingerprint,
          createdAt: now,
          lastUsedAt: null,
          revokedAt: null,
        };
        const created = await devices.createCredential(device);
        if (!created) {
          throw new AuthenticationError(
            'DEVICE_ALREADY_REGISTERED',
            'Generate a new device key for enrollment.',
          );
        }
        await devices.consumeChallenge(challenge.id, now);
        return deviceIdentity(device);
      },
    );
    if (!result) {
      throw invalidCredentials();
    }
    return result;
  }

  /** Return the same public challenge shape for active, revoked, and unknown IDs; authority is checked only on redemption. */
  async requestLogin(input: { credentialId: string; clientIp: string }) {
    await this.limiter.deviceChallenge(input.credentialId, input.clientIp);
    const credential = await this.devices.findCredential(input.credentialId);
    const challenge = this.newChallenge(
      'login',
      input.credentialId,
      this.clock.now(),
      {
        accountId: credential?.revokedAt === null ? credential.accountId : null,
      },
    );
    await this.devices.storeChallenge(challenge);
    return this.challengeResponse(challenge);
  }

  /** Serialize signature redemption with revocation and issue the normal bearer session in the same transaction. */
  async verifyLogin(input: DeviceProof) {
    await this.limiter.deviceVerification(input.clientIp);
    const result = await this.devices.transaction(
      async (devices, authentication) => {
        const candidate = await devices.findCredential(input.credentialId);
        if (!candidate) {
          return null;
        }
        // Recovery/enrollment take the account first; a key lock must not wait on that account in reverse order.
        const account = await authentication.lockAccountById(
          candidate.accountId,
        );
        const credential = await devices.lockCredential(input.credentialId);
        const challenge = await devices.lockChallenge(input.challengeId);
        const now = this.clock.now();
        if (
          !credential ||
          credential.revokedAt !== null ||
          !canRedeemDeviceChallenge(challenge, 'login', input.credentialId, now)
        ) {
          return null;
        }
        if (challenge.accountId !== credential.accountId) {
          return null;
        }
        if (
          !this.signatures.verify(
            credential.publicKey,
            challenge.message,
            input.signature,
          )
        ) {
          return this.rejectProof(devices, challenge.id);
        }
        await devices.consumeChallenge(challenge.id, now);
        if (!account || account.disabledAt !== null) {
          return null;
        }
        await devices.markUsed(credential.id, now);
        return issueSession(
          authentication,
          this.secrets,
          account,
          now,
          credential.id,
        );
      },
    );
    if (!result) {
      throw invalidCredentials();
    }
    return result;
  }

  /** List only the authenticated owner's active registrations, without keys or other accounts' metadata. */
  async list(token: string) {
    const owner = await this.authentication.authenticate(token);
    return (await this.devices.listCredentials(owner.id)).map(deviceIdentity);
  }

  /** Permanently remove an owned key and its sessions; foreign or unknown IDs disclose no existence information. */
  async revoke(token: string, credentialId: string): Promise<void> {
    const digest = this.tokenDigest(token);
    await this.devices.transaction(async (devices, authentication) => {
      const owner = await authentication.findSessionIdentity(
        digest,
        this.clock.now(),
      );
      if (!owner) {
        throw invalidCredentials();
      }
      const credential = await devices.lockCredential(credentialId);
      if (!credential || credential.accountId !== owner.id) {
        return;
      }
      await devices.revokeCredential(credential.id, this.clock.now());
    });
  }

  /** Treat a session as enrollment authority only while active and recently authenticated by password or code. */
  private async enrollmentSession(
    repository: AuthenticationRepository,
    token: string,
    now: Date,
  ) {
    const session = await repository.lockEnrollmentSession(
      this.tokenDigest(token),
      now,
    );
    if (!session) {
      throw invalidCredentials();
    }
    requireRecentPrimaryAuthentication(session, this.clock.now());
    return session;
  }
  /** Avoid storing unbounded active keys and hold enrollment's account lock while checking and inserting. */
  private async requireDeviceCapacity(
    repository: DeviceAuthenticationRepository,
    accountId: string,
  ): Promise<void> {
    if (
      (await repository.countActiveCredentials(accountId)) >=
      deviceAuthenticationPolicy.maxActiveDevices
    ) {
      throw new AuthenticationError(
        'DEVICE_LIMIT_REACHED',
        'Remove an existing device before enrolling another.',
      );
    }
  }
  /** Return a failure value so the transaction preserves failed-signature counts instead of rolling them back. */
  private async rejectProof(
    repository: DeviceAuthenticationRepository,
    id: string,
  ): Promise<null> {
    await repository.recordFailedAttempt(id);
    return null;
  }
  /** Generate unpredictable, purpose-bound signing bytes whose ownership comes exclusively from server state. */
  private newChallenge(
    purpose: DeviceChallenge['purpose'],
    credentialId: string,
    now: Date,
    binding: Partial<
      Pick<
        DeviceChallenge,
        'accountId' | 'enrollmentSessionId' | 'publicKey' | 'deviceName'
      >
    >,
  ): DeviceChallenge {
    const id = this.secrets.id();
    const expiresAt = new Date(
      now.getTime() +
        deviceAuthenticationPolicy.challengeLifetimeSeconds * 1000,
    );
    const message = this.signatures.createMessage({
      purpose,
      challengeId: id,
      credentialId,
      nonce: this.secrets.sessionToken(),
      expiresAt,
    });
    return {
      id,
      purpose,
      credentialId,
      message,
      expiresAt,
      attempts: 0,
      consumedAt: null,
      accountId: null,
      enrollmentSessionId: null,
      publicKey: null,
      deviceName: null,
      ...binding,
    };
  }
  /** Return exact base64url signable bytes; clients must decode rather than sign the encoded string. */
  private challengeResponse(challenge: DeviceChallenge) {
    return {
      challengeId: challenge.id,
      credentialId: challenge.credentialId,
      message: challenge.message,
      algorithm: 'ECDSA_P256_SHA256_DER' as const,
      expiresAt: challenge.expiresAt.toISOString(),
      expiresInSeconds: Math.max(
        0,
        Math.floor(
          (challenge.expiresAt.getTime() - this.clock.now().getTime()) / 1000,
        ),
      ),
    };
  }
  /** Hash an adapter-validated bearer credential for authoritative session lookup. */
  private tokenDigest(token: string): string {
    return this.secrets.tokenDigest(token);
  }
}
