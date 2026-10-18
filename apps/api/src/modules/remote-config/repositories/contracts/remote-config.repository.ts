import type { RemoteConfigFlags } from '../../domain/remote-config.js';

/** Read the last validated configuration while its bounded lifetime remains valid; no request-path provider access or permissive fallback. */
export interface RemoteConfigRepository {
  /** Return a complete immutable policy, or reject when no valid snapshot exists or its maximum age has elapsed. */
  getFlags(): Promise<RemoteConfigFlags>;
}
