/** Stable authentication failures; public messages never reveal whether a contact is registered. */
export class AuthenticationError extends Error {
  /** Carry a safe error code and optional retry delay without retaining credentials. */
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'INVALID_CREDENTIALS'
      | 'AUTHENTICATION_METHOD_DISABLED'
      | 'RECENT_AUTHENTICATION_REQUIRED'
      | 'DEVICE_LIMIT_REACHED'
      | 'DEVICE_ALREADY_REGISTERED'
      | 'RATE_LIMITED'
      | 'DELIVERY_UNAVAILABLE',
    message: string,
    readonly retryAfterSeconds?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AuthenticationError';
  }
}

/** Give all failed credential checks the same public outcome. */
export function invalidCredentials(): AuthenticationError {
  return new AuthenticationError(
    'INVALID_CREDENTIALS',
    'Unable to authenticate with the supplied credentials.',
  );
}
