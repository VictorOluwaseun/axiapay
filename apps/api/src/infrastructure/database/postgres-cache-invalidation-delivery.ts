import {
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import type { RecoverableCache } from '../../shared/cache/recoverable-cache.js';

/** One coalesced, committed invalidation; versions prevent an acknowledgement from deleting newer work for the same cache scope. */
interface PendingInvalidation {
  readonly cache_key: string;
  readonly version: string;
}

/** Fixed storage identifiers are selected by composition, never by request input. */
const invalidationSources = {
  authentication: {
    namespace: 'auth_session_cache_namespace',
    table: 'auth_session_cache_invalidations',
    identity: 'token_digest',
    failureEvent: 'auth_session_cache_invalidation_pending',
  },
  walletSummary: {
    namespace: 'wallet_summary_cache_namespace',
    table: 'wallet_summary_cache_invalidations',
    identity: 'cache_key',
    failureEvent: 'wallet_summary_cache_invalidation_pending',
  },
} as const;

/** Own SQL outbox delivery and bounded recovery; Redis failures retain committed work and temporarily bypass local cache use. */
export class PostgresCacheInvalidationDelivery<Database>
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PostgresCacheInvalidationDelivery.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<void> | null = null;
  private hasReportedFailure = false;
  private stopping = false;

  /** Borrow the root pool and cache port; no open business transaction may await outbox delivery. */
  constructor(
    private readonly database: Kysely<Database>,
    private readonly cache: RecoverableCache,
    private readonly feature: keyof typeof invalidationSources,
  ) {}

  /** Recover committed work at startup and once per second, independently of request reads. */
  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.flush();
    }, 1_000);
    this.timer.unref();
    void this.flush();
  }

  /** Give post-commit callers at most 250 ms; timed-out work continues under the recovery deadline with durable acknowledgements. */
  async flush(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.flushCommittedChanges(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            this.cache.pause();
            resolve();
          }, 250);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Coalesce overlapping delivery attempts while guaranteeing a new commit is checked after an older drain. */
  private async flushCommittedChanges(): Promise<void> {
    // A transaction may have committed after an existing drain's final snapshot. Start
    // a fresh drain after that attempt rather than treating its acknowledgement as ours.
    if (this.pending) {
      await this.pending;
    }
    if (this.stopping) {
      return;
    }
    if (this.pending) {
      return this.pending;
    }
    this.pending = this.drain().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** Invalidate before acknowledging matching versions; rollback/uncommitted rows are invisible and failures remain retryable. */
  private async drain(): Promise<void> {
    if (!this.cache.canSynchronize) {
      this.cache.pause();
      return;
    }
    try {
      const signal = AbortSignal.timeout(1_000);
      const source = invalidationSources[this.feature];
      const namespaceResult = await sql<{
        namespace: string;
      }>`select ${sql.id('public', source.namespace)}() as namespace`.execute(
        this.database,
        { signal },
      );
      const namespace = namespaceResult.rows[0]?.namespace;
      if (!namespace) {
        throw new Error('Cache namespace is unavailable.');
      }
      const recoveryGeneration = this.cache.recoveryGeneration;
      if (this.cache.requiresRecoveryReset) {
        await this.cache.invalidate(namespace, ['*']);
      }
      for (let batch = 0; batch < 4; batch += 1) {
        signal.throwIfAborted();
        const result =
          await sql<PendingInvalidation>`select ${sql.id(source.identity)} as cache_key, version from ${sql.id(source.table)} order by created_at, ${sql.id(source.identity)} limit 256`.execute(
            this.database,
            { signal },
          );
        if (result.rows.length === 0) {
          this.cache.activate(namespace, recoveryGeneration);
          this.hasReportedFailure = false;
          return;
        }
        this.cache.pause();
        await this.cache.invalidate(
          namespace,
          result.rows.map((entry) => entry.cache_key),
        );
        const delivered = sql.join(
          result.rows.map(
            (entry) => sql`(${entry.cache_key}, ${entry.version}::uuid)`,
          ),
        );
        await sql`delete from ${sql.id(source.table)} where (${sql.id(source.identity)}, version) in (${delivered})`.execute(
          this.database,
          { signal },
        );
      }
      // Large backlogs stay durable; the next tick continues while this instance reads PostgreSQL.
      this.cache.pause();
    } catch {
      this.cache.pause();
      if (this.hasReportedFailure) {
        return;
      }
      this.hasReportedFailure = true;
      this.logger.warn({
        event: invalidationSources[this.feature].failureEvent,
        recovery: 'durable_outbox_retry',
      });
    }
  }

  /** Stop recovery before pool shutdown and allow any bounded in-flight attempt to finish. */
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.pending;
  }
}
