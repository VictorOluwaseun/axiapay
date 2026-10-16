import type {
  AuthenticationAccount,
  CodeChallenge,
} from './authentication-models.js';

/** Authentication defaults are kept together so expiry and attempt policy cannot drift across flows. */
export const authenticationPolicy = Object.freeze({
  signupWalletCurrency: 'NGN',
  newPasswordMinCodePoints: 15,
  passwordMaxCodePoints: 128,
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

/** Only an active identity with the issuance-time credential version can use login/recovery proof. */
export function matchesChallengeAccount(
  challenge: CodeChallenge,
  account: AuthenticationAccount,
): boolean {
  return (
    account.disabledAt === null &&
    challenge.accountId === account.id &&
    challenge.credentialVersion === account.credentialVersion
  );
}
