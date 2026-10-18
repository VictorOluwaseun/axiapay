import { Inject, Injectable } from '@nestjs/common';
import { AUTHENTICATION } from '../authentication.tokens.js';
import {
  type AccountIdentity,
  type Contact,
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
  /** Commit bearer revocation and attempt bounded invalidation; durable recovery handles failed delivery and unknown tokens remain idempotent. */
  async logout(token: string): Promise<void> {
    await this.repository.revokeSession(
      this.secrets.tokenDigest(token),
      this.clock.now(),
    );
  }
}
