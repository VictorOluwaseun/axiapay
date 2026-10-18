import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  remoteConfigFlagKeys,
  type RemoteConfig,
} from '../domain/remote-config.js';
import type { RemoteConfigRepository } from '../repositories/contracts/remote-config.repository.js';
import { REMOTE_CONFIG_REPOSITORY } from '../remote-config.tokens.js';

/** Compose the public policy and a deterministic content version from one validated repository snapshot. */
@Injectable()
export class RemoteConfigService {
  /** Depend on a read-only repository contract, never on SQL or a remote provider client. */
  constructor(
    @Inject(REMOTE_CONFIG_REPOSITORY)
    private readonly repository: RemoteConfigRepository,
  ) {}

  /** Version only the public representation; unrelated Firebase edits and refresh timestamps never invalidate a client's identical snapshot. */
  async getConfiguration(): Promise<RemoteConfig> {
    const flags = await this.repository.getFlags();
    const authentication = {
      signup: {
        emailEnabled: flags[remoteConfigFlagKeys.signupEmail],
        phoneEnabled: flags[remoteConfigFlagKeys.signupPhone],
        passwordEnabled: flags[remoteConfigFlagKeys.signupPassword],
        otpEnabled: flags[remoteConfigFlagKeys.signupOtp],
      },
      login: {
        emailEnabled: flags[remoteConfigFlagKeys.loginEmail],
        phoneEnabled: flags[remoteConfigFlagKeys.loginPhone],
        passwordEnabled: flags[remoteConfigFlagKeys.loginPassword],
        otpEnabled: flags[remoteConfigFlagKeys.loginOtp],
      },
    };
    const features = {
      airtime: { enabled: flags[remoteConfigFlagKeys.airtime] },
      data: { enabled: flags[remoteConfigFlagKeys.data] },
      electricity: { enabled: flags[remoteConfigFlagKeys.electricity] },
      tv: { enabled: flags[remoteConfigFlagKeys.tv] },
      education: { enabled: flags[remoteConfigFlagKeys.education] },
      insurance: { enabled: flags[remoteConfigFlagKeys.insurance] },
      bankTransfer: { enabled: flags[remoteConfigFlagKeys.bankTransfer] },
      merchant: { enabled: flags[remoteConfigFlagKeys.merchant] },
      airtimeConversion: {
        enabled: flags[remoteConfigFlagKeys.airtimeConversion],
      },
    };
    const digest = createHash('sha256')
      .update(JSON.stringify({ authentication, features }))
      .digest('hex');
    return { version: `rc1-${digest}`, authentication, features };
  }
}
