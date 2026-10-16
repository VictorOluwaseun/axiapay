/** Reject malformed queue/CLI commands before any recovery or client creation, using the shared input boundary. */
import { describe, expect, it, vi } from 'vitest';
import { withValidatedInput } from '@axiapay/backend/shared/validation/input-validation';
import {
  PaymentRecoverySweepDto,
  RetryPaymentRecoveryDto,
} from './payment-recovery-job.dto.js';

describe('recovery input boundaries', () => {
  it.each([
    {},
    { version: '1' },
    { version: 2 },
    { version: 1, paymentId: 'untrusted-target' },
  ])('rejects an unsupported sweep %j', async (payload) => {
    const recover = vi.fn();
    await expect(
      withValidatedInput(PaymentRecoverySweepDto, payload, recover),
    ).rejects.toBeDefined();
    expect(recover).not.toHaveBeenCalled();
  });

  it('accepts only the documented versioned wake-up', async () => {
    const recover = vi.fn();
    await withValidatedInput(PaymentRecoverySweepDto, { version: 1 }, recover);
    expect(recover).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ version: 1 }),
    );
  });

  it.each([
    { paymentId: 'bad' },
    { paymentId: '4cb51f27-91af-42d0-878c-99c5944919bc', releaseFunds: true },
  ])('rejects invalid operator input %j', async (payload) => {
    const retry = vi.fn();
    await expect(
      withValidatedInput(RetryPaymentRecoveryDto, payload, retry),
    ).rejects.toBeDefined();
    expect(retry).not.toHaveBeenCalled();
  });
});
