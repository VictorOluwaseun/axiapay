/** Recovery controls shared by repository-owned, generation-fenced caches. */
export interface RecoverableCache {
  readonly canSynchronize: boolean;
  readonly recoveryGeneration: number;
  readonly requiresRecoveryReset: boolean;
  /** Fence and remove committed changes; '*' rotates the namespace epoch. Failed delivery must throw. */
  invalidate(namespace: string, identities: readonly string[]): Promise<void>;
  /** Bypass local cache reads while durable delivery is pending. */
  pause(): void;
  /** Resume only for the connection lifetime whose outbox was drained. */
  activate(namespace: string, recoveryGeneration: number): void;
}
