import type { RedisCacheConnection } from './redis-cache-connection.js';

/** Fence cache reads across startup, failed delivery and reconnect until a bounded outbox recovery succeeds. */
export class RecoverableRedisCache {
  protected namespace: string | null = null;
  protected synchronized = false;
  private connectionGeneration = 0;
  private recoveredGeneration = -1;

  /** Observe reconnects through the lifecycle-managed cache client. */
  constructor(protected readonly connection: RedisCacheConnection) {
    this.connection.client.on('close', () => this.connectionChanged());
    this.connection.client.on('ready', () => this.connectionChanged());
  }

  /** Expose connection readiness without authorizing cached reads before replay. */
  get canSynchronize(): boolean {
    return this.connection.canUseCache;
  }

  /** Capture the connection lifetime that a recovery attempt is allowed to enable. */
  get recoveryGeneration(): number {
    return this.connectionGeneration;
  }

  /** Reset even an empty outbox after reconnect, since Redis failover may restore previously acknowledged stale data. */
  get requiresRecoveryReset(): boolean {
    return this.recoveredGeneration !== this.connectionGeneration;
  }

  /** Fence local cache use across connection changes before recovery performs a namespace reset. */
  protected connectionChanged(): void {
    this.connectionGeneration += 1;
    this.pause();
  }

  /** Bypass cached snapshots until pending invalidations are replayed. */
  pause(): void {
    this.synchronized = false;
  }

  /** Publish a recovered namespace only after its committed outbox is empty. */
  activate(namespace: string, recoveryGeneration: number): void {
    if (
      recoveryGeneration !== this.connectionGeneration ||
      !this.connection.canUseCache
    ) {
      return;
    }
    this.namespace = namespace;
    this.recoveredGeneration = recoveryGeneration;
    this.synchronized = true;
  }
}
