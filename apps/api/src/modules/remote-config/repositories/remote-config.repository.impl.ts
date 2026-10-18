import {
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import type { RemoteConfigFlags } from '../domain/remote-config.js';
import { RemoteConfigUnavailableError } from '../domain/remote-config-error.js';
import type { RemoteConfigRepository } from './contracts/remote-config.repository.js';
import type { RemoteConfigDataSource } from './contracts/remote-config.data-source.js';

/** Millisecond limits for provider refresh, total fetch duration and retained policy validity. */
export interface RemoteConfigRefreshOptions {
  readonly refreshIntervalMs: number;
  readonly fetchTimeoutMs: number;
  readonly maxAgeMs: number;
}

/** Own a bounded, immutable Firebase snapshot and background refresh lifecycle; PostgreSQL and request-triggered provider calls are excluded. */
export class RemoteConfigRepositoryImpl
  implements RemoteConfigRepository, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RemoteConfigRepositoryImpl.name);
  private snapshot?: { flags: RemoteConfigFlags; validatedAtMs: number };
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private refreshPromise?: Promise<void>;
  private refreshController?: AbortController;
  private stopped = false;
  private lastFailure?: unknown;

  /** Receive provider access, validated timing policy and a monotonic clock; null source leaves configuration explicitly unavailable. */
  constructor(
    private readonly source: RemoteConfigDataSource | null,
    private readonly options: RemoteConfigRefreshOptions,
    private readonly nowMs: () => number = () => performance.now(),
  ) {}

  /** Start one background refresh without blocking unrelated application startup on Firebase availability. */
  onModuleInit(): void {
    void this.refresh();
  }

  /** Return only a current snapshot; failures and expiry never turn disabled authentication methods back on. */
  async getFlags(): Promise<RemoteConfigFlags> {
    if (
      this.stopped ||
      !this.snapshot ||
      this.nowMs() - this.snapshot.validatedAtMs >= this.options.maxAgeMs
    ) {
      throw new RemoteConfigUnavailableError({ cause: this.lastFailure });
    }
    return this.snapshot.flags;
  }

  /** Coalesce refreshes, then schedule the next attempt after completion; authentication callers never invoke this infrastructure operation. */
  refresh(): Promise<void> {
    if (this.stopped || !this.source) {
      return Promise.resolve();
    }
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    this.refreshPromise = this.fetchSnapshot(this.source).finally(() => {
      this.refreshPromise = undefined;
      this.scheduleRefresh();
    });
    return this.refreshPromise;
  }

  /** Stop timers, cancel active work and prevent late provider completion from publishing after shutdown. */
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.refreshTimer);
    this.refreshController?.abort();
    await this.refreshPromise;
  }

  /** Bound the complete refresh, including credential discovery; retain the last valid policy without renewing its age on failure. */
  private async fetchSnapshot(source: RemoteConfigDataSource): Promise<void> {
    const controller = new AbortController();
    this.refreshController = controller;
    let rejectAborted: () => void = () => undefined;
    const aborted = new Promise<never>((_, reject) => {
      rejectAborted = () => reject(new RemoteConfigUnavailableError());
      controller.signal.addEventListener('abort', rejectAborted, {
        once: true,
      });
    });
    const deadline = setTimeout(
      () => controller.abort(),
      this.options.fetchTimeoutMs,
    );
    deadline.unref();
    try {
      const flags = await Promise.race([
        source.loadFlags(controller.signal),
        aborted,
      ]);
      if (this.stopped || controller.signal.aborted) {
        return;
      }
      this.snapshot = {
        flags: Object.freeze({ ...flags }),
        validatedAtMs: this.nowMs(),
      };
      if (this.lastFailure !== undefined) {
        this.logger.log({ event: 'remote_config_refresh_recovered' });
      }
      this.lastFailure = undefined;
    } catch (cause) {
      if (this.stopped) {
        return;
      }
      if (this.lastFailure === undefined) {
        this.logger.warn({
          event: 'remote_config_refresh_failed',
          message: 'Firebase configuration could not be refreshed.',
        });
      }
      this.lastFailure = cause;
    } finally {
      clearTimeout(deadline);
      controller.signal.removeEventListener('abort', rejectAborted);
      this.refreshController = undefined;
    }
  }

  /** Keep exactly one unreferenced recovery timer and retry failures at the configured bounded frequency. */
  private scheduleRefresh(): void {
    if (this.stopped) {
      return;
    }
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(
      () => void this.refresh(),
      this.options.refreshIntervalMs,
    );
    this.refreshTimer.unref();
  }
}
