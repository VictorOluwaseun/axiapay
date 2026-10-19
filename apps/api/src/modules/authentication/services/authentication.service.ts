import { Inject, Injectable } from '@nestjs/common';
import { AUTHENTICATION } from '../authentication.tokens.js';
import {
  type AccountIdentity,
  type Contact,
  accountIdentity,
} from '../domain/authentication-models.js';
import { invalidCredentials } from '../domain/authentication-error.js';
import type {
  AuthenticationClock,
  AuthenticationSecrets,
  PasswordHasher,
  AuthenticationAttemptLimiter,
} from '../ports/authentication.ports.js';
import type { AuthenticationRepository } from '../repositories/contracts/authentication.repository.js';
import { AuthenticationCodeService } from './authentication-code.service.js';
import { AuthenticationRateLimiter } from './authentication-rate-limiter.service.js';
import { RemoteConfigService } from '../../remote-config/services/remote-config.service.js';
import { assertAuthenticationMethodEnabled } from '../domain/authentication-method-policy.js';
import { authenticationPolicy } from '../domain/authentication-policy.js';
import {
  issueSession,
  type AuthenticationResult,
} from './authentication-session.js';

/** Public code requests omit purpose; each service operation binds it to its intended flow. */
type CodeRequest = Omit<
  Parameters<AuthenticationCodeService['request']>[0],
  'purpose'
>;
/** Verification inputs cannot choose a different purpose from the requested service operation. */
type CodeVerification = Omit<
  Parameters<AuthenticationCodeService['verify']>[0],
  'purpose'
>;

/** Own password login and session access; delegate the cohesive code lifecycle to AuthenticationCodeService. */
@Injectable()
export class AuthenticationService {
  /** Inject repository/capability contracts and focused collaborators; no HTTP, SQL, or cache clients enter this service. */
  constructor(
    @Inject(AUTHENTICATION.repository)
    private readonly repository: AuthenticationRepository,
    @Inject(AUTHENTICATION.passwords)
    private readonly passwords: PasswordHasher,
    @Inject(AUTHENTICATION.secrets)
    private readonly secrets: AuthenticationSecrets,
    @Inject(AuthenticationRateLimiter)
    private readonly limiter: AuthenticationAttemptLimiter,
    @Inject(AUTHENTICATION.clock) private readonly clock: AuthenticationClock,
    @Inject(AuthenticationCodeService)
    private readonly codes: AuthenticationCodeService,
    @Inject(RemoteConfigService)
    private readonly configuration: RemoteConfigService,
  ) {}
  /** Request mandatory contact proof before activation, with an optional password for future login. */
  signup(input: CodeRequest) {
    return this.codes.request({ ...input, purpose: 'signup' });
  }
  /** Redeem signup proof and atomically activate the account, its empty NGN wallet and session. */
  verifySignup(input: CodeVerification): Promise<AuthenticationResult> {
    return this.codes.verify({ ...input, purpose: 'signup' });
  }
  /** Request proof for login without exposing whether the contact is registered. */
  requestLoginCode(input: Omit<CodeRequest, 'password'>) {
    return this.codes.request({ ...input, purpose: 'login' });
  }
  /** Redeem a login challenge without implicitly creating an account. */
  loginWithCode(input: CodeVerification): Promise<AuthenticationResult> {
    return this.codes.verify({ ...input, purpose: 'login' });
  }
  /** Request purpose-bound recovery without exposing registration status; the canonical contact is already validated. */
  requestPasswordReset(input: Omit<CodeRequest, 'password'>) {
    return this.codes.request({ ...input, purpose: 'password-reset' });
  }
  /** Complete code-authorized recovery without signing in; all sessions and device registrations must be re-established. */
  resetPassword(
    input: CodeVerification & { newPassword: string },
  ): Promise<void> {
    return this.codes.resetPassword(input);
  }
  /** Apply throttling before hashing, then create a fresh session only after successful verification. */
  async loginWithPassword(input: {
    contact: Contact;
    password: string;
    clientIp: string;
  }): Promise<AuthenticationResult> {
    const { contact } = input;
    const configuration = await this.configuration.getConfiguration();
    assertAuthenticationMethodEnabled(
      configuration.authentication,
      'login',
      contact.kind,
      'password',
    );
    await this.limiter.passwordLogin(contact, input.clientIp);
    const account = await this.repository.findAccount(contact);
    const valid = await this.passwords.verify(
      input.password,
      account?.passwordHash ?? null,
    );
    if (!valid || !account || account.disabledAt !== null) {
      throw invalidCredentials();
    }
    return issueSession(
      this.repository,
      this.secrets,
      account,
      this.clock.now(),
    );
  }
  /** Resolve the caller; protected writes require current session/account state and never rely on cached revocation state. */
  async authenticate(
    token: string,
    requireCurrentState = false,
  ): Promise<AccountIdentity> {
    const account = await this.repository.findSessionIdentity(
      this.secrets.tokenDigest(token),
      this.clock.now(),
      requireCurrentState,
    );
    if (!account) {
      throw invalidCredentials();
    }
    return account;
  }
  /** Rotate one-use refresh proof without extending family expiry or primary-authentication freshness. */
  async refreshSession(input: {
    refreshToken: string;
    clientIp: string;
  }): Promise<AuthenticationResult> {
    const digest = this.secrets.tokenDigest(input.refreshToken);
    await this.limiter.sessionRefresh(digest, input.clientIp);
    const result = await this.repository.transaction(async (repository) => {
      const candidate = await repository.findRefreshSession(digest);
      if (!candidate) {
        return null;
      }
      const account = await repository.lockAccountById(candidate.accountId);
      const session = await repository.findRefreshSession(digest, true);
      if (
        !account ||
        account.disabledAt !== null ||
        !session ||
        session.revokedAt !== null
      ) {
        return null;
      }
      const now = this.clock.now();
      if (session.consumedAt !== null) {
        // Return, then reject after commit: throwing here would undo replay revocation.
        await repository.revokeSessionById(session.id, now);
        return null;
      }
      const refreshExpiresInSeconds = Math.floor(
        ((session.refreshExpiresAt?.getTime() ?? 0) - now.getTime()) / 1000,
      );
      if (refreshExpiresInSeconds <= 0) {
        return null;
      }
      const expiresInSeconds = Math.min(
        authenticationPolicy.accessTokenLifetimeSeconds,
        refreshExpiresInSeconds,
      );
      const accessToken = this.secrets.sessionToken();
      const refreshToken = this.secrets.sessionToken();
      await repository.rotateSession({
        sessionId: session.id,
        previousRefreshDigest: digest,
        accessTokenDigest: this.secrets.tokenDigest(accessToken),
        refreshTokenDigest: this.secrets.tokenDigest(refreshToken),
        accessExpiresAt: new Date(now.getTime() + expiresInSeconds * 1000),
        now,
      });
      return {
        accessToken,
        refreshToken,
        sessionId: session.id,
        tokenType: 'Bearer' as const,
        expiresInSeconds,
        refreshExpiresInSeconds,
        account: accountIdentity(account),
      };
    });
    if (!result) {
      throw invalidCredentials();
    }
    return result;
  }
  /** Commit bearer revocation and attempt bounded invalidation; durable recovery handles failed delivery and unknown tokens remain idempotent. */
  async logout(token: string): Promise<void> {
    await this.repository.revokeSession(
      this.secrets.tokenDigest(token),
      this.clock.now(),
    );
  }
}
