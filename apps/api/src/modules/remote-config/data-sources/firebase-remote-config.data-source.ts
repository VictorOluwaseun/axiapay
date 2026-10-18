import { GoogleAuth } from 'google-auth-library';
import { z } from 'zod';
import {
  remoteConfigFlagKeys,
  type RemoteConfigFlags,
} from '../domain/remote-config.js';
import type { RemoteConfigDataSource } from '../repositories/contracts/remote-config.data-source.js';

/** Map application policy keys to Firebase's supported parameter naming format. */
export const firebaseConfigParameters = {
  [remoteConfigFlagKeys.signupEmail]: 'auth_signup_email_enabled',
  [remoteConfigFlagKeys.signupPhone]: 'auth_signup_phone_enabled',
  [remoteConfigFlagKeys.signupPassword]: 'auth_signup_password_enabled',
  [remoteConfigFlagKeys.signupOtp]: 'auth_signup_otp_enabled',
  [remoteConfigFlagKeys.loginEmail]: 'auth_login_email_enabled',
  [remoteConfigFlagKeys.loginPhone]: 'auth_login_phone_enabled',
  [remoteConfigFlagKeys.loginPassword]: 'auth_login_password_enabled',
  [remoteConfigFlagKeys.loginOtp]: 'auth_login_otp_enabled',
  [remoteConfigFlagKeys.airtime]: 'feature_airtime_enabled',
  [remoteConfigFlagKeys.data]: 'feature_data_enabled',
  [remoteConfigFlagKeys.electricity]: 'feature_electricity_enabled',
  [remoteConfigFlagKeys.tv]: 'feature_tv_enabled',
  [remoteConfigFlagKeys.education]: 'feature_education_enabled',
  [remoteConfigFlagKeys.insurance]: 'feature_insurance_enabled',
  [remoteConfigFlagKeys.bankTransfer]: 'feature_bank_transfer_enabled',
  [remoteConfigFlagKeys.merchant]: 'feature_merchant_enabled',
  [remoteConfigFlagKeys.airtimeConversion]:
    'feature_airtime_conversion_enabled',
} as const;

const templateSchema = z.object({
  parameters: z.record(z.string(), z.unknown()),
});
const booleanParameterSchema = z.object({
  valueType: z.literal('BOOLEAN'),
  defaultValue: z.object({ value: z.enum(['true', 'false']) }).strict(),
  conditionalValues: z
    .record(z.string(), z.unknown())
    .optional()
    .refine(
      (values) => values === undefined || Object.keys(values).length === 0,
    ),
});

/** Read Firebase's server namespace using its documented REST API and Google Application Default Credentials. */
export class FirebaseRemoteConfigDataSource implements RemoteConfigDataSource {
  /** Own a reusable authenticated client; timeouts also apply to OAuth transport, and credentials never enter application contracts. */
  constructor(
    private readonly projectId: string,
    private readonly timeoutMs: number,
    private readonly authentication: Pick<
      GoogleAuth,
      'request'
    > = new GoogleAuth({
      projectId,
      scopes: ['https://www.googleapis.com/auth/firebase.remoteconfig'],
      clientOptions: {
        transporterOptions: { timeout: timeoutMs, retry: false },
      },
    }),
  ) {}

  /** Validate supplied global BOOLEAN parameters atomically; absent payment switches are disabled, while authentication values remain required. */
  async loadFlags(signal: AbortSignal): Promise<RemoteConfigFlags> {
    const response = await this.authentication.request<unknown>({
      method: 'GET',
      url: `https://firebaseremoteconfig.googleapis.com/v1/projects/${encodeURIComponent(this.projectId)}/remoteConfig`,
      params: {
        name: `projects/${this.projectId}/namespaces/firebase-server/remoteConfig`,
      },
      responseType: 'json',
      timeout: this.timeoutMs,
      retry: false,
      maxRedirects: 0,
      signal,
    });
    const template = templateSchema.safeParse(response.data);
    if (!template.success) {
      throw new Error('Invalid Firebase Remote Config template shape.');
    }
    const flags = {} as Record<keyof typeof firebaseConfigParameters, boolean>;
    for (const key of Object.values(remoteConfigFlagKeys)) {
      // Additive rollout: absent payment switches deny new purchases without disabling an existing authentication policy.
      if (
        key.startsWith('features.') &&
        template.data.parameters[firebaseConfigParameters[key]] === undefined
      ) {
        flags[key] = false;
        continue;
      }
      const parameter = booleanParameterSchema.safeParse(
        template.data.parameters[firebaseConfigParameters[key]],
      );
      if (!parameter.success) {
        throw new Error(
          `Invalid Firebase configuration parameter: ${firebaseConfigParameters[key]}.`,
        );
      }
      flags[key] = parameter.data.defaultValue.value === 'true';
    }
    return Object.freeze(flags);
  }
}
