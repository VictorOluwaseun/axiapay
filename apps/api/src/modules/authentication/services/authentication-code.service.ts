import { Inject, Injectable } from '@nestjs/common';
import { AUTHENTICATION } from '../authentication.tokens.js';
import type {
  AuthenticationAccount,
  CodeChallenge,
  Contact,
} from '../domain/authentication-models.js';
import {
  authenticationPolicy,
  canRedeemChallenge,
  matchesChallengeAccount,
} from '../domain/authentication-policy.js';
import {
  AuthenticationError,
  invalidCredentials,
} from '../domain/authentication-error.js';
import type {
  AuthenticationClock,
  AuthenticationCodeDelivery,
  AuthenticationSecrets,
  PasswordHasher,
  AuthenticationAttemptLimiter,
} from '../ports/authentication.ports.js';
import type { AuthenticationRepository } from '../repositories/contracts/authentication.repository.js';
import { AuthenticationRateLimiter } from './authentication-rate-limiter.service.js';
import {
  issueSession,
  type AuthenticationResult,
} from './authentication-session.js';

/** Bind validated code proofs to a server-selected purpose; transport shape is checked before service entry. */
interface CodeVerification {
  readonly purpose: CodeChallenge['purpose'];
  readonly challengeId: string;
  readonly code: string;
  readonly clientIp: string;
}

/** Own code issuance, bounded single-use redemption, account activation, and atomic credential recovery. */
@Injectable()
export class AuthenticationCodeService {
  /** Inject persistence and capability ports; storage and messaging clients stay behind their implementations. */
  constructor(
    @Inject(AUTHENTICATION.repository)
    private readonly repository: AuthenticationRepository,
    @Inject(AUTHENTICATION.codeDelivery)
    private readonly delivery: AuthenticationCodeDelivery,
    @Inject(AUTHENTICATION.secrets)
    private readonly secrets: AuthenticationSecrets,
    @Inject(AUTHENTICATION.passwords)
    private readonly passwords: PasswordHasher,
    @Inject(AuthenticationRateLimiter)
    private readonly limiter: AuthenticationAttemptLimiter,
    @Inject(AUTHENTICATION.clock) private readonly clock: AuthenticationClock,
  ) {}
  /** Persist before delivery; all contacts follow the same path, but unknown/disabled identities gain no login or reset authority. */
  async request(input: {
    purpose: CodeChallenge['purpose'];
    contact: Contact;
    password?: string;
    clientIp: string;
  }) {
    const { contact } = input;
    await this.limiter.codeRequest(contact, input.clientIp);
    const passwordHash =
      input.password === undefined
        ? null
        : await this.passwords.hash(input.password);
    const account =
      input.purpose === 'signup'
        ? null
        : await this.repository.findAccount(contact);
    const binding = account?.disabledAt === null ? account : null;
    const now = this.clock.now();
    const expiresAt = new Date(
      now.getTime() + authenticationPolicy.codeLifetimeSeconds * 1000,
    );
    const id = this.secrets.id();
    const code = this.secrets.code();
    await this.repository.storeChallenge({
      id,
      contact,
      purpose: input.purpose,
      accountId: binding?.id ?? null,
      credentialVersion: binding?.credentialVersion ?? null,
      passwordHash,
      codeDigest: this.secrets.codeDigest(id, code),
      createdAt: now,
      expiresAt,
      attempts: 0,
      status: 'pending',
    });
    try {
      await this.delivery.send({
        contact,
        code,
        purpose: input.purpose,
        challengeId: id,
        expiresInSeconds: authenticationPolicy.codeLifetimeSeconds,
      });
    } catch (cause) {
      await this.repository.changeChallengeStatus(id, 'pending', 'invalidated');
      throw new AuthenticationError(
        'DELIVERY_UNAVAILABLE',
        'Unable to deliver a code. Please try again later.',
        undefined,
        { cause },
      );
    }
    await this.repository.changeChallengeStatus(id, 'pending', 'ready');
    return {
      challengeId: id,
      expiresAt: expiresAt.toISOString(),
      expiresInSeconds: Math.max(
        0,
        Math.floor((expiresAt.getTime() - this.clock.now().getTime()) / 1000),
      ),
      resendAfterSeconds: authenticationPolicy.resendAfterSeconds,
    };
  }
  /** Redeem signup/login only; reset-purpose codes never create a session through this operation. */
  verify(
    input: CodeVerification & { purpose: 'signup' | 'login' },
  ): Promise<AuthenticationResult> {
    return this.redeem(input, async (repository, challenge) => {
      const now = this.clock.now();
      const account = await this.resolveAccount(repository, challenge, now);
      if (!account || account.disabledAt !== null) {
        return null;
      }
      return issueSession(repository, this.secrets, account, now);
    });
  }
  /** Replace a validated new password only after code ownership proof; consumption, version change and revocation commit together. */
  async resetPassword(
    input: Omit<CodeVerification, 'purpose'> & { newPassword: string },
  ): Promise<void> {
    await this.redeem(
      { ...input, purpose: 'password-reset' },
      async (repository, challenge) => {
        if (!challenge.accountId) {
          return null;
        }
        const account = await repository.lockAccountById(challenge.accountId);
        if (!account || !matchesChallengeAccount(challenge, account)) {
          return null;
        }
        // Hash only a proven, current code. Keep the account lock through replacement to serialize concurrent recovery/enrollment.
        const passwordHash = await this.passwords.hash(input.newPassword);
        const now = this.clock.now();
        if (!canRedeemChallenge(challenge, 'password-reset', now)) {
          return null;
        }
        return (await repository.replacePassword(account, passwordHash, now))
          ? true
          : null;
      },
    );
  }
  /** Commit failed-guess counts before returning a generic failure; exceptions roll back consumption and all callback writes. */
  private async redeem<Result>(
    input: CodeVerification,
    operation: (
      repository: AuthenticationRepository,
      challenge: CodeChallenge,
    ) => Promise<Result | null>,
  ): Promise<Result> {
    await this.limiter.codeVerification(input.clientIp);
    const result = await this.repository.transaction(async (repository) => {
      const challenge = await repository.lockChallenge(input.challengeId);
      if (
        !challenge ||
        !canRedeemChallenge(challenge, input.purpose, this.clock.now())
      ) {
        return null;
      }
      if (
        !this.secrets.matches(
          challenge.codeDigest,
          this.secrets.codeDigest(challenge.id, input.code),
        )
      ) {
        await repository.recordWrongCode(challenge.id);
        return null;
      }
      await repository.changeChallengeStatus(challenge.id, 'ready', 'consumed');
      return operation(repository, challenge);
    });
    if (result === null) {
      throw invalidCredentials();
    }
    return result;
  }
  /** Signup cannot overwrite an identity; login proof is bound to the account/version that existed when the code was sent. */
  private async resolveAccount(
    repository: AuthenticationRepository,
    challenge: CodeChallenge,
    now: Date,
  ): Promise<AuthenticationAccount | null> {
    if (challenge.purpose !== 'signup') {
      const account = await repository.findAccount(challenge.contact);
      return account && matchesChallengeAccount(challenge, account)
        ? account
        : null;
    }
    return repository.createAccount({
      id: this.secrets.id(),
      contact: challenge.contact,
      passwordHash: challenge.passwordHash,
      credentialVersion: 0,
      createdAt: now,
      verifiedAt: now,
      disabledAt: null,
    });
  }
}
