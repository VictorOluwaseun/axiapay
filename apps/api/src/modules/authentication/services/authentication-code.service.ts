import { Inject, Injectable } from '@nestjs/common';
import { AUTHENTICATION } from '../authentication.tokens.js';
import type {
  AuthenticationAccount,
  CodeChallenge,
  Contact,
} from '../domain/authentication-models.js';
import {
  authenticationPolicy,
  normalizeContact,
  validateNewPassword,
  canRedeemChallenge,
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

/** Own the code lifecycle: issuance, provider acceptance, guesses, atomic redemption, and account activation. */
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
  /** Persist a pending challenge before delivery; a delivery failure invalidates it and returns no credentials. */
  async request(input: {
    purpose: CodeChallenge['purpose'];
    contact: Contact;
    password?: string;
    clientIp: string;
  }) {
    const contact = normalizeContact(input.contact);
    if (input.purpose === 'login' && input.password !== undefined) {
      throw new AuthenticationError(
        'INVALID_INPUT',
        'A code login request does not accept a password.',
      );
    }
    if (input.password !== undefined) {
      validateNewPassword(input.password);
    }
    await this.limiter.codeRequest(contact, input.clientIp);
    const passwordHash =
      input.password === undefined
        ? null
        : await this.passwords.hash(input.password);
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
  /** Commit failed-guess counters before returning a generic error; an exception inside the transaction would undo them. */
  async verify(input: {
    purpose: CodeChallenge['purpose'];
    challengeId: string;
    code: string;
    clientIp: string;
  }): Promise<AuthenticationResult> {
    await this.limiter.codeVerification(input.clientIp);
    const result = await this.repository.transaction(async (repository) => {
      const challenge = await repository.lockChallenge(input.challengeId);
      const now = this.clock.now();
      if (!challenge || !canRedeemChallenge(challenge, input.purpose, now)) {
        return null;
      }
      const matches = this.secrets.matches(
        challenge.codeDigest,
        this.secrets.codeDigest(challenge.id, input.code),
      );
      if (!matches) {
        return this.recordWrongCode(repository, challenge.id);
      }
      await repository.changeChallengeStatus(challenge.id, 'ready', 'consumed');
      const account = await this.resolveAccount(repository, challenge, now);
      if (!account || account.disabledAt !== null) {
        return null;
      }
      return issueSession(repository, this.secrets, account, now);
    });
    if (!result) {
      throw invalidCredentials();
    }
    return result;
  }
  /** Keep the failed result explicit so the transaction commits its attempt count. */
  private async recordWrongCode(
    repository: AuthenticationRepository,
    id: string,
  ): Promise<null> {
    await repository.recordWrongCode(id);
    return null;
  }
  /** Signup creates a new verified identity only; existing credentials are never replaced or silently linked. */
  private async resolveAccount(
    repository: AuthenticationRepository,
    challenge: CodeChallenge,
    now: Date,
  ): Promise<AuthenticationAccount | null> {
    if (challenge.purpose === 'login') {
      return repository.findAccount(challenge.contact);
    }
    return repository.createAccount({
      id: this.secrets.id(),
      contact: challenge.contact,
      passwordHash: challenge.passwordHash,
      createdAt: now,
      verifiedAt: now,
      disabledAt: null,
    });
  }
}
