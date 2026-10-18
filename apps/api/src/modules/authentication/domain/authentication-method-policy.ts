import type { AuthenticationConfiguration } from '../../remote-config/domain/remote-config.js';
import type { Contact } from './authentication-models.js';
import { AuthenticationError } from './authentication-error.js';

/** A passwordless code flow is distinct from the mandatory contact proof used by password signup. */
export type AuthenticationCredentialMethod = 'password' | 'otp';

/** Require both the contact and credential choice independently of account existence; recovery and existing access retain separate policies. */
export function assertAuthenticationMethodEnabled(
  configuration: AuthenticationConfiguration,
  operation: 'signup' | 'login',
  contactKind: Contact['kind'],
  credentialMethod: AuthenticationCredentialMethod,
): void {
  const methods = configuration[operation];
  const contactEnabled =
    contactKind === 'email' ? methods.emailEnabled : methods.phoneEnabled;
  const credentialEnabled =
    credentialMethod === 'password'
      ? methods.passwordEnabled
      : methods.otpEnabled;
  if (!contactEnabled || !credentialEnabled) {
    throw new AuthenticationError(
      'AUTHENTICATION_METHOD_DISABLED',
      'This authentication option is currently unavailable for this operation.',
    );
  }
}
