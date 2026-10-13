import type { Contact } from '../domain/authentication-models.js';
import { AuthenticationError } from '../domain/authentication-error.js';
import type {
  AuthenticationAttemptLimiter,
  AuthenticationClock,
  AuthenticationSecrets,
} from '../ports/authentication.ports.js';
import type { AuthenticationRepository } from '../repositories/contracts/authentication.repository.js';

/** Apply shared IP and canonical-contact budgets before credential hashing or code delivery. */
export class AuthenticationRateLimiter implements AuthenticationAttemptLimiter {
  /** Receive only repository and crypto ports; storage clients remain in infrastructure. */
  constructor(
    private readonly repository: AuthenticationRepository,
    private readonly secrets: AuthenticationSecrets,
    private readonly clock: AuthenticationClock,
  ) {}
  /** Bound per-IP sending plus contact resend frequency and hourly delivery volume across purposes. */
  async codeRequest(contact: Contact, clientIp: string): Promise<void> {
    await this.take('code-ip', clientIp, 30, 600);
    await this.take(
      'code-contact-minute',
      `${contact.kind}:${contact.value}`,
      1,
      60,
    );
    await this.take(
      'code-contact-hour',
      `${contact.kind}:${contact.value}`,
      5,
      3600,
    );
  }
  /** Bound distributed password guessing and CPU-heavy hashing without permanent account lockout. */
  async passwordLogin(contact: Contact, clientIp: string): Promise<void> {
    await this.take('password-ip', clientIp, 50, 900);
    await this.take(
      'password-contact',
      `${contact.kind}:${contact.value}`,
      10,
      900,
    );
  }
  /** Bound challenge probing; each stored challenge independently limits code guesses. */
  async codeVerification(clientIp: string): Promise<void> {
    await this.take('verify-ip', clientIp, 100, 900);
  }
  /** Fail closed when a budget is exhausted or its authoritative store cannot be reached. */
  private async take(
    scope: string,
    identity: string,
    limit: number,
    seconds: number,
  ): Promise<void> {
    const retryAfterSeconds = await this.repository.takeRateLimit(
      this.secrets.rateLimitKey(scope, identity),
      limit,
      seconds,
      this.clock.now(),
    );
    if (retryAfterSeconds > 0) {
      throw new AuthenticationError(
        'RATE_LIMITED',
        'Too many attempts. Try again later.',
        retryAfterSeconds,
      );
    }
  }
}
