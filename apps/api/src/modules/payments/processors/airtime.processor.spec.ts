/** Verify protocol composition, exact request identity, independent calls and uncertain-outcome recovery without a live provider. */
import { describe, expect, it, vi } from 'vitest';
import {
  airtimeInstruction,
  pendingAirtimeSubmission,
  testAirtimeAdapter,
  type TestAirtimeResponse,
} from '../../../../tests/support/airtime-processor-fixture.js';
import { paymentTermsFingerprint } from '../domain/payment.js';
import { AirtimeProcessor } from './airtime.processor.js';

describe('AxiaPay airtime processor', () => {
  it.each(['submit', 'lookup'] as const)(
    'runs the injected validator once before the %s pipeline',
    async (operation) => {
      const payment = airtimeInstruction();
      const adapter = {
        ...testAirtimeAdapter(),
        validate: vi.fn(),
      };
      await new AirtimeProcessor(adapter)[operation](payment);
      expect(adapter.validate).toHaveBeenCalledExactlyOnceWith({
        scope: 'quote',
        terms: payment.quote,
      });
    },
  );

  it.each(['submit', 'lookup'] as const)(
    'does not enter %s when the single injected validator rejects the terms',
    async (operation) => {
      const failure = new Error('Unsupported provider terms');
      const adapter = {
        ...testAirtimeAdapter(),
        validate: vi.fn(() => {
          throw failure;
        }),
      };
      await expect(
        new AirtimeProcessor(adapter)[operation](airtimeInstruction()),
      ).rejects.toBe(failure);
      expect(adapter.toRequest).not.toHaveBeenCalled();
      expect(adapter.execute).not.toHaveBeenCalled();
      expect(adapter.toSubmission).not.toHaveBeenCalled();
      expect(adapter.lookup).not.toHaveBeenCalled();
    },
  );

  it('translates exact accepted terms and passes the original instruction into response mapping', async () => {
    const payment = airtimeInstruction();
    const adapter = testAirtimeAdapter();
    const processor = new AirtimeProcessor(adapter);

    expect(await processor.submit(payment)).toEqual(
      pendingAirtimeSubmission(payment),
    );
    expect(adapter.execute).toHaveBeenCalledExactlyOnceWith({
      merchantReference: payment.id,
      productCode: payment.quote.providerProductCode,
      recipient: payment.quote.recipientPhoneNumber,
      amountMinorUnits: '10000',
      currency: 'NGN',
      termsFingerprint: paymentTermsFingerprint(payment),
    });
    expect(adapter.toSubmission).toHaveBeenCalledExactlyOnceWith(
      { observation: pendingAirtimeSubmission(payment) },
      payment,
    );
    expect(adapter.lookup).not.toHaveBeenCalled();
  });

  it.each(['pending', 'succeeded', 'failed'] as const)(
    'preserves a correlated %s observation without deciding wallet settlement',
    async (outcome) => {
      const payment = airtimeInstruction();
      const adapter = testAirtimeAdapter();
      const result =
        outcome === 'pending'
          ? pendingAirtimeSubmission(payment)
          : {
              ...pendingAirtimeSubmission(payment),
              outcome,
              providerTransactionReference: 'test-provider-movement',
              evidenceReference: 'test-evidence',
              fundsSafeToRelease: false,
            };
      adapter.execute.mockResolvedValue({ observation: result });

      expect(await new AirtimeProcessor(adapter).submit(payment)).toBe(result);
      expect(adapter.execute).toHaveBeenCalledTimes(1);
    },
  );

  it('never calls the provider when request mapping fails', async () => {
    const adapter = testAirtimeAdapter();
    const error = new Error('Unsupported configured product');
    adapter.toRequest.mockImplementationOnce(() => {
      throw error;
    });

    await expect(
      new AirtimeProcessor(adapter).submit(airtimeInstruction()),
    ).rejects.toBe(error);
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(adapter.toSubmission).not.toHaveBeenCalled();
  });

  it('preserves a transport timeout and performs no retry or invented final mapping', async () => {
    const adapter = testAirtimeAdapter();
    const error = new Error('Provider transport timed out');
    adapter.execute.mockRejectedValueOnce(error);

    await expect(
      new AirtimeProcessor(adapter).submit(airtimeInstruction()),
    ).rejects.toBe(error);
    expect(adapter.execute).toHaveBeenCalledTimes(1);
    expect(adapter.toSubmission).not.toHaveBeenCalled();
    expect(adapter.lookup).not.toHaveBeenCalled();
  });

  it('preserves rejected upstream evidence without resubmitting the purchase', async () => {
    const adapter = testAirtimeAdapter();
    const error = new Error('Untrusted provider evidence');
    adapter.toSubmission.mockImplementationOnce(() => {
      throw error;
    });

    await expect(
      new AirtimeProcessor(adapter).submit(airtimeInstruction()),
    ).rejects.toBe(error);
    expect(adapter.execute).toHaveBeenCalledTimes(1);
    expect(adapter.lookup).not.toHaveBeenCalled();
  });

  it.each(['submit', 'lookup'] as const)(
    'rejects other service types and changed provider routing before %s',
    async (operation) => {
      const payment = airtimeInstruction();
      const adapter = testAirtimeAdapter();
      const processor = new AirtimeProcessor(adapter);
      await expect(
        processor[operation]({
          ...payment,
          quote: { ...payment.quote, serviceType: 'data' },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_PAYMENT' });
      await expect(
        processor[operation]({
          ...payment,
          quote: { ...payment.quote, providerKey: 'another-account' },
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_UNAVAILABLE' });
      expect(adapter.toRequest).not.toHaveBeenCalled();
      expect(adapter.execute).not.toHaveBeenCalled();
      expect(adapter.toSubmission).not.toHaveBeenCalled();
      expect(adapter.lookup).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['submit', 'paymentId'],
    ['submit', 'termsFingerprint'],
    ['lookup', 'paymentId'],
    ['lookup', 'termsFingerprint'],
  ] as const)(
    'rejects mismatched %s evidence for %s',
    async (operation, field) => {
      const payment = airtimeInstruction();
      const adapter = testAirtimeAdapter();
      const result = {
        ...pendingAirtimeSubmission(payment),
        [field]: 'mismatched-evidence',
      };
      adapter.toSubmission.mockReturnValueOnce(result);
      adapter.lookup.mockResolvedValueOnce(result);

      await expect(
        new AirtimeProcessor(adapter)[operation](payment),
      ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_EVIDENCE' });
    },
  );

  it('keeps lookup separate from every purchase stage', async () => {
    const payment = airtimeInstruction();
    const adapter = testAirtimeAdapter();
    expect(await new AirtimeProcessor(adapter).lookup(payment)).toEqual(
      pendingAirtimeSubmission(payment),
    );
    expect(adapter.lookup).toHaveBeenCalledExactlyOnceWith(payment);
    expect(adapter.toRequest).not.toHaveBeenCalled();
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(adapter.toSubmission).not.toHaveBeenCalled();
  });

  it('propagates enquiry failure without falling back to a new purchase', async () => {
    const adapter = testAirtimeAdapter();
    const error = new Error('Status enquiry unavailable');
    adapter.lookup.mockRejectedValueOnce(error);
    await expect(
      new AirtimeProcessor(adapter).lookup(airtimeInstruction()),
    ).rejects.toBe(error);
    expect(adapter.lookup).toHaveBeenCalledTimes(1);
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it('keeps overlapping requests isolated when provider responses arrive out of order', async () => {
    const first = airtimeInstruction();
    const second = airtimeInstruction();
    const adapter = testAirtimeAdapter();
    let finishFirst!: (response: TestAirtimeResponse) => void;
    adapter.execute.mockImplementationOnce(
      () => new Promise((resolve) => (finishFirst = resolve)),
    );
    const processor = new AirtimeProcessor(adapter);
    const firstSubmission = processor.submit(first);
    expect(await processor.submit(second)).toEqual(
      pendingAirtimeSubmission(second),
    );
    finishFirst({ observation: pendingAirtimeSubmission(first) });
    expect(await firstSubmission).toEqual(pendingAirtimeSubmission(first));
    expect(
      adapter.toSubmission.mock.calls.map(([, payment]) => payment.id),
    ).toEqual([second.id, first.id]);
  });
});
