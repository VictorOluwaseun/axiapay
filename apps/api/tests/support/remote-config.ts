import {
  remoteConfigFlagKeys,
  type RemoteConfigFlagKey,
  type RemoteConfigFlags,
} from '../../src/modules/remote-config/domain/remote-config.js';
import type { RemoteConfigRepository } from '../../src/modules/remote-config/repositories/contracts/remote-config.repository.js';

/** Complete enabled policy for isolated tests; production never binds this fixture or uses it as a failure fallback. */
export function enabledRemoteConfigFlags(): RemoteConfigFlags {
  return {
    [remoteConfigFlagKeys.signupEmail]: true,
    [remoteConfigFlagKeys.signupPhone]: true,
    [remoteConfigFlagKeys.signupPassword]: true,
    [remoteConfigFlagKeys.signupOtp]: true,
    [remoteConfigFlagKeys.loginEmail]: true,
    [remoteConfigFlagKeys.loginPhone]: true,
    [remoteConfigFlagKeys.loginPassword]: true,
    [remoteConfigFlagKeys.loginOtp]: true,
    [remoteConfigFlagKeys.airtime]: true,
    [remoteConfigFlagKeys.data]: true,
    [remoteConfigFlagKeys.electricity]: true,
    [remoteConfigFlagKeys.tv]: true,
    [remoteConfigFlagKeys.education]: true,
    [remoteConfigFlagKeys.insurance]: true,
    [remoteConfigFlagKeys.bankTransfer]: true,
    [remoteConfigFlagKeys.merchant]: true,
    [remoteConfigFlagKeys.airtimeConversion]: true,
  };
}

/** Explicitly injected test policy, independent of Firebase credentials and authentication's real PostgreSQL transactions. */
export class TestRemoteConfigRepository implements RemoteConfigRepository {
  private flags = enabledRemoteConfigFlags();

  /** Expose immutable snapshots so test changes affect only subsequent authentication operations. */
  async getFlags(): Promise<RemoteConfigFlags> {
    return Object.freeze({ ...this.flags });
  }

  /** Publish one known setting without changing any other authentication or payment setting. */
  setFlag(key: RemoteConfigFlagKey, enabled: boolean): void {
    this.flags = { ...this.flags, [key]: enabled };
  }

  /** Restore independent test policy without modifying any application database. */
  reset(): void {
    this.flags = enabledRemoteConfigFlags();
  }
}
