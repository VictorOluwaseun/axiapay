import type { CodeChallenge } from './authentication-models.js';

/** Authentication defaults are kept together so expiry and attempt policy cannot drift across flows. */
export const authenticationPolicy = Object.freeze({
  codeLifetimeSeconds: 300,
  codeAttempts: 5,
  resendAfterSeconds: 60,
  sessionLifetimeSeconds: 86_400,
});

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
