/** Verify bounded Firebase policy retention, refresh concurrency, timeouts and shutdown independently of network access. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { RemoteConfigRepositoryImpl } from './remote-config.repository.impl.js';
import type { RemoteConfigDataSource } from './contracts/remote-config.data-source.js';
import type { RemoteConfigFlags } from '../domain/remote-config.js';
import { remoteConfigFlagKeys } from '../domain/remote-config.js';
import { RemoteConfigUnavailableError } from '../domain/remote-config-error.js';
import { enabledRemoteConfigFlags } from '../../../../tests/support/remote-config.js';

let nowMs = 0;
let repositories: RemoteConfigRepositoryImpl[] = [];

/** Assemble a lifecycle owner with explicit test time and timing limits in milliseconds. */
function repository(source: RemoteConfigDataSource | null) {
  const result = new RemoteConfigRepositoryImpl(
    source,
    { refreshIntervalMs: 1000, fetchTimeoutMs: 100, maxAgeMs: 5000 },
    () => nowMs,
  );
  repositories.push(result);
  return result;
}

/** Control provider completion to test timeout and shutdown races, including transports that ignore cancellation. */
function pendingFlags() {
  let resolve!: (flags: RemoteConfigFlags) => void;
  const promise = new Promise<RemoteConfigFlags>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  nowMs = 0;
  repositories = [];
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(async () => {
  await Promise.all(repositories.map((entry) => entry.onModuleDestroy()));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('remote configuration snapshot lifecycle', () => {
  it('leaves missing setup unavailable without timers or an enabled fallback', async () => {
    const configuration = repository(null);
    configuration.onModuleInit();
    await expect(configuration.getFlags()).rejects.toBeInstanceOf(
      RemoteConfigUnavailableError,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('loads in the background, coalesces refreshes and serves request-path reads without further provider access', async () => {
    const pending = pendingFlags();
    const source = { loadFlags: vi.fn().mockReturnValue(pending.promise) };
    const configuration = repository(source);
    await expect(configuration.getFlags()).rejects.toBeInstanceOf(
      RemoteConfigUnavailableError,
    );
    expect(source.loadFlags).not.toHaveBeenCalled();
    configuration.onModuleInit();
    const first = configuration.refresh();
    expect(configuration.refresh()).toBe(first);
    const supplied = { ...enabledRemoteConfigFlags() };
    pending.resolve(supplied);
    await first;
    supplied[remoteConfigFlagKeys.signupEmail] = false;
    const reads = await Promise.all(
      Array.from({ length: 20 }, () => configuration.getFlags()),
    );
    expect(
      reads.every((flags) => flags[remoteConfigFlagKeys.signupEmail]),
    ).toBe(true);
    expect(Object.isFrozen(reads[0])).toBe(true);
    expect(source.loadFlags).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
  });

  it('retains disabled methods through refresh failures but rejects at the exact maximum age, then recovers', async () => {
    const disabled = {
      ...enabledRemoteConfigFlags(),
      [remoteConfigFlagKeys.loginPhone]: false,
    };
    const source = { loadFlags: vi.fn().mockResolvedValue(disabled) };
    const configuration = repository(source);
    await configuration.refresh();
    const failure = new Error('private Firebase credential details');
    source.loadFlags.mockRejectedValue(failure);
    nowMs = 4999;
    await configuration.refresh();
    await configuration.refresh();
    expect(
      (await configuration.getFlags())[remoteConfigFlagKeys.loginPhone],
    ).toBe(false);
    expect(Logger.prototype.warn).toHaveBeenCalledOnce();
    expect(
      JSON.stringify(vi.mocked(Logger.prototype.warn).mock.calls),
    ).not.toContain('private');
    nowMs = 5000;
    await expect(configuration.getFlags()).rejects.toMatchObject({
      name: 'RemoteConfigUnavailableError',
      cause: failure,
    });
    source.loadFlags.mockResolvedValue(disabled);
    await configuration.refresh();
    expect(
      (await configuration.getFlags())[remoteConfigFlagKeys.loginPhone],
    ).toBe(false);
    expect(Logger.prototype.log).toHaveBeenCalledWith({
      event: 'remote_config_refresh_recovered',
    });
    nowMs = 9999;
    await expect(configuration.getFlags()).resolves.toEqual(disabled);
  });

  it('times out and cancels a hung refresh, and cannot let its late result overwrite a newer snapshot', async () => {
    const pending = pendingFlags();
    const source = {
      loadFlags: vi
        .fn()
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValue(enabledRemoteConfigFlags()),
    };
    const configuration = repository(source);
    const refresh = configuration.refresh();
    const signal = source.loadFlags.mock.calls[0]![0] as AbortSignal;
    await vi.advanceTimersByTimeAsync(100);
    await refresh;
    expect(signal.aborted).toBe(true);
    await expect(configuration.getFlags()).rejects.toBeInstanceOf(
      RemoteConfigUnavailableError,
    );
    await configuration.refresh();
    pending.resolve({
      ...enabledRemoteConfigFlags(),
      [remoteConfigFlagKeys.signupPhone]: false,
    });
    await Promise.resolve();
    expect(
      (await configuration.getFlags())[remoteConfigFlagKeys.signupPhone],
    ).toBe(true);
  });

  it('refreshes periodically and renews validity after a successful unchanged snapshot', async () => {
    const source = {
      loadFlags: vi.fn().mockResolvedValue(enabledRemoteConfigFlags()),
    };
    const configuration = repository(source);
    configuration.onModuleInit();
    await configuration.refresh();
    nowMs = 4000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(source.loadFlags).toHaveBeenCalledTimes(2);
    nowMs = 7000;
    await expect(configuration.getFlags()).resolves.toEqual(
      enabledRemoteConfigFlags(),
    );
    expect(vi.getTimerCount()).toBe(1);
  });

  it('aborts pending work and cancels every timer during shutdown, with no late publication or retries', async () => {
    const pending = pendingFlags();
    const source = { loadFlags: vi.fn().mockReturnValue(pending.promise) };
    const configuration = repository(source);
    configuration.onModuleInit();
    const signal = source.loadFlags.mock.calls[0]![0] as AbortSignal;
    await configuration.onModuleDestroy();
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    pending.resolve(enabledRemoteConfigFlags());
    await vi.advanceTimersByTimeAsync(10000);
    await expect(configuration.getFlags()).rejects.toBeInstanceOf(
      RemoteConfigUnavailableError,
    );
    expect(source.loadFlags).toHaveBeenCalledOnce();
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
  });
});
