/** Verify the shared pipeline across service categories, including exact Airtime mapping, concurrent calls and lookup-only recovery. */
import { describe, it, expect, vi } from 'vitest';
import {
  airtimeInstruction,
  pendingAirtimeSubmission,
  testAirtimeAdapter,
  type TestAirtimeResponse,
} from '../../../../tests/support/airtime-processor-fixture.js';
import {
  serviceInstruction,
  serviceProcessorCases,
} from '../../../../tests/support/service-processor-fixture.js';
import { paymentTermsFingerprint } from '../domain/payment.js';
import { ServicePaymentProcessor } from './service-payment.processor.js';

describe('purchase preparation validation ownership', () => {
  it.each([true, false])(
    'validates once with external terms checking enabled=%s',
    async (hasExternalCheck) => {
      const payment = airtimeInstruction();
      const validate = vi.fn();
      const verifyPurchaseTerms = vi.fn(async () => {});
      const adapter = {
        ...testAirtimeAdapter(),
        validate,
        ...(hasExternalCheck ? { verifyPurchaseTerms } : {}),
      };
      await new ServicePaymentProcessor('airtime', adapter).preparePurchase(
        payment.quote,
      );
      expect(validate).toHaveBeenCalledExactlyOnceWith({
        scope: 'quote',
        terms: payment.quote,
      });
      expect(verifyPurchaseTerms).toHaveBeenCalledTimes(
        hasExternalCheck ? 1 : 0,
      );
      expect(adapter.toRequest).not.toHaveBeenCalled();
      expect(adapter.execute).not.toHaveBeenCalled();
    },
  );

  it('retains review-only availability reporting without suppressing validation of a fresh purchase', async () => {
    const payment = airtimeInstruction();
    const failure = new Error('Unsupported new purchase');
    const adapter = {
      ...testAirtimeAdapter(),
      validate: vi.fn(() => {
        throw failure;
      }),
    };
    const processor = new ServicePaymentProcessor('airtime', adapter);
    await processor.verifyPurchaseTerms(payment.quote);
    expect(adapter.validate).not.toHaveBeenCalled();
    await expect(processor.preparePurchase(payment.quote)).rejects.toBe(
      failure,
    );
    expect(adapter.validate).toHaveBeenCalledTimes(1);
    expect(adapter.execute).not.toHaveBeenCalled();
  });
});

describe.each(serviceProcessorCases)(
  '%s provider-neutral processor',
  (serviceType) => {
    it('sequences any injected provider protocol and keeps recovery outside all purchase stages', async () => {
      const payment = serviceInstruction(serviceType);
      const result = {
        paymentId: payment.id,
        termsFingerprint: paymentTermsFingerprint(payment),
        outcome: 'pending' as const,
      };
      const request = { providerRequest: 'independent provider wire format' };
      const response = { independentlyAuthenticatedObservation: 'test' };
      const adapter = {
        providerKey: payment.quote.providerKey,
        validate: vi.fn(),
        toRequest: vi.fn(() => request),
        execute: vi.fn(async () => response),
        toSubmission: vi.fn(() => result),
        lookup: vi.fn(async () => result),
      };
      const processor = new ServicePaymentProcessor(serviceType, adapter);
      expect(await processor.submit(payment)).toEqual(result);
      expect(adapter.validate).toHaveBeenCalledExactlyOnceWith({
        scope: 'quote',
        terms: payment.quote,
      });
      expect(adapter.toRequest).toHaveBeenCalledExactlyOnceWith(payment);
      expect(adapter.execute).toHaveBeenCalledExactlyOnceWith(request);
      expect(adapter.toSubmission).toHaveBeenCalledExactlyOnceWith(
        response,
        payment,
      );
      adapter.validate.mockImplementation(() => {
        throw new Error('Withdrawn for new purchases');
      });
      expect(await processor.lookup(payment)).toEqual(result);
      expect(adapter.toRequest).toHaveBeenCalledTimes(1);
      expect(adapter.execute).toHaveBeenCalledTimes(1);
      expect(adapter.lookup).toHaveBeenCalledExactlyOnceWith(payment);
    });
    it('rejects a different service or provider account even with a permissive custom validator', async () => {
      const payment = serviceInstruction(serviceType);
      const adapter = {
        providerKey: payment.quote.providerKey,
        validate: vi.fn(),
        toRequest: vi.fn(),
        execute: vi.fn(),
        toSubmission: vi.fn(),
        lookup: vi.fn(),
      };
      const processor = new ServicePaymentProcessor(serviceType, adapter);
      await expect(
        processor.submit({
          ...payment,
          quote: { ...payment.quote, serviceType: 'bank_transfer' },
        }),
      ).rejects.toMatchObject({ reason: 'SERVICE_NOT_SUPPORTED' });
      await expect(
        processor.lookup({
          ...payment,
          quote: { ...payment.quote, providerKey: 'another-provider' },
        }),
      ).rejects.toMatchObject({ reason: 'PROVIDER_ROUTE_MISMATCH' });
      expect(adapter.validate).not.toHaveBeenCalled();
      expect(adapter.execute).not.toHaveBeenCalled();
    });
  },
);

describe('shared service processor with airtime terms', () => {
  it('runs the injected purchase validator once before submission', async () => {
    const payment = airtimeInstruction();
    const adapter = {
      ...testAirtimeAdapter(),
      validate: vi.fn(),
    };
    await new ServicePaymentProcessor('airtime', adapter).submit(payment);
    expect(adapter.validate).toHaveBeenCalledExactlyOnceWith({
      scope: 'quote',
      terms: payment.quote,
    });
  });

  it('does not submit when the injected purchase validator rejects the terms', async () => {
    const failure = new Error('Unsupported provider terms');
    const adapter = {
      ...testAirtimeAdapter(),
      validate: vi.fn(() => {
        throw failure;
      }),
    };
    await expect(
      new ServicePaymentProcessor('airtime', adapter).submit(
        airtimeInstruction(),
      ),
    ).rejects.toBe(failure);
    expect(adapter.toRequest).not.toHaveBeenCalled();
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(adapter.toSubmission).not.toHaveBeenCalled();
    expect(adapter.lookup).not.toHaveBeenCalled();
  });

  it('translates exact accepted terms and passes the original instruction into response mapping', async () => {
    const payment = airtimeInstruction();
    const adapter = testAirtimeAdapter();
    const processor = new ServicePaymentProcessor('airtime', adapter);

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

      expect(
        await new ServicePaymentProcessor('airtime', adapter).submit(payment),
      ).toBe(result);
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
      new ServicePaymentProcessor('airtime', adapter).submit(
        airtimeInstruction(),
      ),
    ).rejects.toBe(error);
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(adapter.toSubmission).not.toHaveBeenCalled();
  });

  it('preserves a transport timeout and performs no retry or invented final mapping', async () => {
    const adapter = testAirtimeAdapter();
    const error = new Error('Provider transport timed out');
    adapter.execute.mockRejectedValueOnce(error);

    await expect(
      new ServicePaymentProcessor('airtime', adapter).submit(
        airtimeInstruction(),
      ),
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
      new ServicePaymentProcessor('airtime', adapter).submit(
        airtimeInstruction(),
      ),
    ).rejects.toBe(error);
    expect(adapter.execute).toHaveBeenCalledTimes(1);
    expect(adapter.lookup).not.toHaveBeenCalled();
  });

  it.each(['submit', 'lookup'] as const)(
    'rejects other service types and changed provider routing before %s',
    async (operation) => {
      const payment = airtimeInstruction();
      const adapter = testAirtimeAdapter();
      const processor = new ServicePaymentProcessor('airtime', adapter);
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

  it('keeps lookup separate from every purchase stage', async () => {
    const payment = airtimeInstruction();
    const adapter = {
      ...testAirtimeAdapter(),
      validate: vi.fn(() => {
        throw new Error('This product is no longer available for purchase');
      }),
    };
    expect(
      await new ServicePaymentProcessor('airtime', adapter).lookup(payment),
    ).toEqual(pendingAirtimeSubmission(payment));
    expect(adapter.lookup).toHaveBeenCalledExactlyOnceWith(payment);
    expect(adapter.validate).not.toHaveBeenCalled();
    expect(adapter.toRequest).not.toHaveBeenCalled();
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(adapter.toSubmission).not.toHaveBeenCalled();
  });

  it('rejects another provider account during lookup even when a custom purchase validator exists', async () => {
    const adapter = { ...testAirtimeAdapter(), validate: vi.fn() };
    await expect(
      new ServicePaymentProcessor('airtime', adapter).lookup(
        airtimeInstruction('other-account'),
      ),
    ).rejects.toMatchObject({
      code: 'PAYMENT_UNAVAILABLE',
      reason: 'PROVIDER_ROUTE_MISMATCH',
    });
    expect(adapter.validate).not.toHaveBeenCalled();
    expect(adapter.lookup).not.toHaveBeenCalled();
  });

  it('propagates enquiry failure without falling back to a new purchase', async () => {
    const adapter = testAirtimeAdapter();
    const error = new Error('Status enquiry unavailable');
    adapter.lookup.mockRejectedValueOnce(error);
    await expect(
      new ServicePaymentProcessor('airtime', adapter).lookup(
        airtimeInstruction(),
      ),
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
    const processor = new ServicePaymentProcessor('airtime', adapter);
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
