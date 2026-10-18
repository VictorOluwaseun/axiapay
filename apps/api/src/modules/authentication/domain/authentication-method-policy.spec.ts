/** Check the full contact/credential product without allowing one operation to gate the other. */
import { describe, expect, it } from 'vitest';
import { assertAuthenticationMethodEnabled } from './authentication-method-policy.js';
import type { AuthenticationConfiguration } from '../../remote-config/domain/remote-config.js';

/** Supply explicit complete policy; this test fixture is never an application fallback. */
function enabledPolicy(): AuthenticationConfiguration {
  return {
    signup: {
      emailEnabled: true,
      phoneEnabled: true,
      passwordEnabled: true,
      otpEnabled: true,
    },
    login: {
      emailEnabled: true,
      phoneEnabled: true,
      passwordEnabled: true,
      otpEnabled: true,
    },
  };
}

describe('authentication contact and credential policy', () => {
  for (const operation of ['signup', 'login'] as const) {
    for (const contact of ['email', 'phone'] as const) {
      for (const credential of ['password', 'otp'] as const) {
        it(`requires both ${contact} and ${credential} for ${operation}`, () => {
          const policy = enabledPolicy();
          expect(() =>
            assertAuthenticationMethodEnabled(
              policy,
              operation,
              contact,
              credential,
            ),
          ).not.toThrow();
          for (const field of [
            contact === 'email' ? 'emailEnabled' : 'phoneEnabled',
            credential === 'password' ? 'passwordEnabled' : 'otpEnabled',
          ] as const) {
            const disabled = {
              ...policy,
              [operation]: { ...policy[operation], [field]: false },
            };
            expect(() =>
              assertAuthenticationMethodEnabled(
                disabled,
                operation,
                contact,
                credential,
              ),
            ).toThrow(
              'This authentication option is currently unavailable for this operation.',
            );
            const otherOperation = operation === 'signup' ? 'login' : 'signup';
            expect(() =>
              assertAuthenticationMethodEnabled(
                disabled,
                otherOperation,
                contact,
                credential,
              ),
            ).not.toThrow();
          }
          const otherCredential =
            credential === 'password' ? 'otp' : 'password';
          const disabledCredential = {
            ...policy,
            [operation]: {
              ...policy[operation],
              [credential === 'password' ? 'passwordEnabled' : 'otpEnabled']:
                false,
            },
          };
          expect(() =>
            assertAuthenticationMethodEnabled(
              disabledCredential,
              operation,
              contact,
              otherCredential,
            ),
          ).not.toThrow();
        });
      }
    }
  }
});
