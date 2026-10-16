import type { AccountIdentity } from '../../domain/authentication-models.js';

/** Credential-free identity and absolute session deadline; cache storage never owns payment authorization. */
export interface CachedSessionIdentity {
  readonly identity: AccountIdentity;
  readonly expiresAtMs: number;
}

/** Generation observed before loading PostgreSQL; invalidation or eviction makes old fill tickets unusable. */
export interface SessionCacheFillTicket {
  readonly namespace: string;
  readonly epoch: string;
  readonly generation: string;
}

/** One atomic Redis lookup returns a cached identity or a generation for a conditional fill. */
export interface SessionCacheLookup {
  readonly snapshot: CachedSessionIdentity | null;
  readonly ticket: SessionCacheFillTicket;
}

/** Repository-owned storage; hit validation and stale-fill fencing use Redis only. */
export interface SessionIdentityCache {
  /** Whether Redis can accept bounded invalidation work. */
  readonly canSynchronize: boolean;
  /** Monotonic local connection generation prevents an old recovery attempt enabling a newly reconnected cache. */
  readonly recoveryGeneration: number;
  /** Reconnect/startup must rotate the namespace epoch before cache hits resume. */
  readonly requiresRecoveryReset: boolean;
  /** Return a signed hit/fill ticket, or null when paused or unavailable. */
  read(tokenDigest: string, now: Date): Promise<SessionCacheLookup | null>;
  /** Publish committed identity data only while the pre-read generation matches. */
  write(
    tokenDigest: string,
    snapshot: CachedSessionIdentity,
    now: Date,
    ticket: SessionCacheFillTicket,
  ): Promise<void>;
  /** Rotate generations and delete affected entries; '*' resets the namespace. Throw on failure for durable retry. */
  invalidate(namespace: string, tokenDigests: readonly string[]): Promise<void>;
  /** Bypass cached identities until committed work has been replayed. */
  pause(): void;
  /** Enable cache use after startup/reconnect recovery has drained the outbox. */
  activate(namespace: string, recoveryGeneration: number): void;
}
