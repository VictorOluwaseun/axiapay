import { AuthenticationError } from './authentication-error.js';
import type { CodeChallenge, Contact } from './authentication-models.js';

/** Authentication defaults are kept together so expiry and attempt policy cannot drift across flows. */
export const authenticationPolicy = Object.freeze({
  codeLifetimeSeconds: 300,
  codeAttempts: 5,
  resendAfterSeconds: 60,
  sessionLifetimeSeconds: 86_400,
});

/** Canonicalize email case and require explicit international phone numbers; never guess a country. */
export function normalizeContact(contact: Contact): Contact {
  const value = contact.value.trim();
  if (contact.kind === 'phone' && /^\+[1-9]\d{7,14}$/.test(value))
    return { kind: 'phone', value };
  if (contact.kind === 'phone')
    throw new AuthenticationError(
      'INVALID_INPUT',
      'Use an international phone number such as +2348012345678.',
    );
  if (
    contact.kind !== 'email' ||
    value.length > 254 ||
    !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(
      value,
    )
  ) {
    throw new AuthenticationError(
      'INVALID_INPUT',
      'Enter a valid email address.',
    );
  }
  const localPart = value.split('@')[0] ?? '';
  if (
    localPart.length > 64 ||
    localPart.startsWith('.') ||
    localPart.endsWith('.') ||
    localPart.includes('..')
  )
    throw new AuthenticationError(
      'INVALID_INPUT',
      'Enter a valid email address.',
    );
  return { kind: 'email', value: value.toLowerCase() };
}

/** Allow long Unicode passphrases without trimming or composition rules; bound expensive hashing input. */
export function validateNewPassword(password: string): void {
  const length = Array.from(password).length;
  if (length < 15 || length > 128)
    throw new AuthenticationError(
      'INVALID_INPUT',
      'Use a password between 15 and 128 characters.',
    );
}

/** Check immutable challenge policy before comparing its secret or applying any account changes. */
export function canRedeemChallenge(
  challenge: CodeChallenge,
  purpose: CodeChallenge['purpose'],
  now: Date,
): boolean {
  return (
    challenge.purpose === purpose &&
    challenge.status === 'ready' &&
    challenge.attempts < authenticationPolicy.codeAttempts &&
    challenge.expiresAt.getTime() > now.getTime()
  );
}
