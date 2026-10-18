import type { RemoteConfigFlags } from '../../domain/remote-config.js';

/** Fetch and validate one complete provider snapshot; cancellation must prevent publication of late results. */
export interface RemoteConfigDataSource {
  /** Load global authentication switches, excluding unrelated provider settings and rejecting missing or unsupported values. */
  loadFlags(signal: AbortSignal): Promise<RemoteConfigFlags>;
}
