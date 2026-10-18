/** Explicit allowlist of application settings; provider parameters alone never expand the public contract. */
export const remoteConfigFlagKeys = {
  signupEmail: 'authentication.signup.emailEnabled',
  signupPhone: 'authentication.signup.phoneEnabled',
  signupPassword: 'authentication.signup.passwordEnabled',
  signupOtp: 'authentication.signup.otpEnabled',
  loginEmail: 'authentication.login.emailEnabled',
  loginPhone: 'authentication.login.phoneEnabled',
  loginPassword: 'authentication.login.passwordEnabled',
  loginOtp: 'authentication.login.otpEnabled',
  airtime: 'features.airtime.enabled',
  data: 'features.data.enabled',
  electricity: 'features.electricity.enabled',
  tv: 'features.tv.enabled',
  education: 'features.education.enabled',
  insurance: 'features.insurance.enabled',
  bankTransfer: 'features.bankTransfer.enabled',
  merchant: 'features.merchant.enabled',
  airtimeConversion: 'features.airtimeConversion.enabled',
} as const;

/** Known boolean settings that can be overridden without deploying or restarting the API. */
export type RemoteConfigFlagKey =
  (typeof remoteConfigFlagKeys)[keyof typeof remoteConfigFlagKeys];

/** A complete validated policy; missing or malformed provider values must never enable a capability implicitly. */
export type RemoteConfigFlags = Readonly<Record<RemoteConfigFlagKey, boolean>>;

/** Independent contact and credential choices for one operation; both must permit the requested flow. */
export interface AuthenticationMethodsConfiguration {
  readonly emailEnabled: boolean;
  readonly phoneEnabled: boolean;
  readonly passwordEnabled: boolean;
  readonly otpEnabled: boolean;
}

/** Signup and login availability are independent; recovery, device login and existing sessions are outside this policy. */
export interface AuthenticationConfiguration {
  readonly signup: AuthenticationMethodsConfiguration;
  readonly login: AuthenticationMethodsConfiguration;
}

/** Public, non-secret application settings; authentication decisions still enforce the current server policy. */
export interface RemoteConfig {
  /** Opaque identity of the public configuration, independent of provider metadata and unrelated parameters. */
  readonly version: string;
  readonly authentication: AuthenticationConfiguration;
  readonly features: FeaturesConfiguration;
}

/** Independently controlled customer payment features; enablement does not imply provider readiness. */
export interface FeaturesConfiguration {
  readonly airtime: { readonly enabled: boolean };
  readonly data: { readonly enabled: boolean };
  readonly electricity: { readonly enabled: boolean };
  readonly tv: { readonly enabled: boolean };
  readonly education: { readonly enabled: boolean };
  readonly insurance: { readonly enabled: boolean };
  readonly bankTransfer: { readonly enabled: boolean };
  readonly merchant: { readonly enabled: boolean };
  readonly airtimeConversion: { readonly enabled: boolean };
}
