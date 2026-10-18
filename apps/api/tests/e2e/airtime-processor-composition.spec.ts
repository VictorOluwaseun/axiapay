/** Verify injected adapters through real payment-module composition, preserving one submission claim and lookup-only timeout recovery. */
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { DatabaseConnection } from '@axiapay/payments-runtime/infrastructure/database/database.module';
import { PaymentsCoreModule } from '@axiapay/payments-runtime/modules/payments/payments-core.module';
import { PAYMENTS } from '@axiapay/payments-runtime/modules/payments/payments.tokens';
import { ServicePaymentProcessor } from '@axiapay/payments-runtime/modules/payments/processors/service-payment.processor';
import type { PaymentProviders } from '@axiapay/payments-runtime/modules/payments/ports/service-payment-provider';
import type { ServicePayment } from '@axiapay/payments-runtime/modules/payments/domain/payment';
import { PaymentExecutionService } from '@axiapay/payments-runtime/modules/payments/services/payment-execution.service';
import {
  airtimeInstruction,
  testAirtimeAdapter,
} from '../../../../packages/payments-runtime/tests/support/airtime-processor-fixture.js';

const FIRST_ADAPTER = Symbol('FirstTestAirtimeAdapter');
const SECOND_ADAPTER = Symbol('SecondTestAirtimeAdapter');

/** Export only test protocol adapters; production has no implicit provider registration. */
@Module({
  providers: [
    {
      provide: FIRST_ADAPTER,
      useFactory: () => testAirtimeAdapter('test-airtime:merchant-a'),
    },
    {
      provide: SECOND_ADAPTER,
      useFactory: () => testAirtimeAdapter('test-airtime:merchant-b'),
    },
  ],
  exports: [FIRST_ADAPTER, SECOND_ADAPTER],
})
class TestAirtimeAdaptersModule {}

describe('airtime processor composition', () => {
  it('injects independent provider adapters and recovers a claimed timeout through enquiry without another purchase', async () => {
    const first = { ...airtimeInstruction(), submissionStartedAt: null };
    const second = {
      ...airtimeInstruction('test-airtime:merchant-b'),
      submissionStartedAt: null,
    };
    const stored = new Map<string, ServicePayment>([
      [first.id, first],
      [second.id, second],
    ]);
    const repository = {
      /** Read committed payment progress, without replacing wallet or SQL integration coverage. */
      getPayment: vi.fn(async (id: string) => stored.get(id) ?? null),
      /** Simulate the existing durable one-time claim contract for this composition check. */
      claimSubmission: vi.fn(async (id: string) => {
        const payment = stored.get(id);
        if (!payment || payment.submissionStartedAt) {
          return false;
        }
        stored.set(id, {
          ...payment,
          submissionStartedAt: new Date('2030-01-01T00:00:01Z'),
        });
        return true;
      }),
    };
    const module = await Test.createTestingModule({
      imports: [
        PaymentsCoreModule.register({
          featurePolicy: { useValue: { isEnabled: async () => true } },
          imports: [TestAirtimeAdaptersModule],
          fulfilment: {
            inject: [FIRST_ADAPTER, SECOND_ADAPTER],
            /** Assemble plain processors at the existing Nest composition boundary; services never receive provider wire types. */
            useFactory: (
              firstAdapter: ReturnType<typeof testAirtimeAdapter>,
              secondAdapter: ReturnType<typeof testAirtimeAdapter>,
            ): PaymentProviders => ({
              [firstAdapter.providerKey]: {
                adapter: new ServicePaymentProcessor('airtime', firstAdapter),
                partnerAccountId: first.partnerAccountId,
                feeAccountId: first.feeAccountId,
              },
              [secondAdapter.providerKey]: {
                adapter: new ServicePaymentProcessor('airtime', secondAdapter),
                partnerAccountId: second.partnerAccountId,
                feeAccountId: second.feeAccountId,
              },
            }),
          },
        }),
      ],
    })
      .overrideProvider(DatabaseConnection)
      .useValue({ database: {} })
      .overrideProvider(PAYMENTS.repository)
      .useValue(repository)
      .compile();

    try {
      const execution = module.get(PaymentExecutionService);
      const firstAdapter =
        module.get<ReturnType<typeof testAirtimeAdapter>>(FIRST_ADAPTER);
      const secondAdapter =
        module.get<ReturnType<typeof testAirtimeAdapter>>(SECOND_ADAPTER);
      const timeout = new Error('Provider acknowledgement lost');
      firstAdapter.execute.mockRejectedValueOnce(timeout);

      await expect(execution.dispatch(first)).rejects.toMatchObject({
        code: 'PAYMENT_UNAVAILABLE',
        cause: timeout,
      });
      const submitted = await execution.get(first.ownerId, first.id);
      expect(submitted.submissionStartedAt).not.toBeNull();
      expect(submitted.reservationStatus).toBe('reserved');
      expect(submitted.outcome).toBeNull();
      await execution.dispatch(submitted);
      await execution.reconcile(submitted);

      expect(firstAdapter.execute).toHaveBeenCalledTimes(1);
      expect(firstAdapter.toSubmission).not.toHaveBeenCalled();
      expect(firstAdapter.lookup).toHaveBeenCalledExactlyOnceWith(submitted);
      expect(secondAdapter.execute).not.toHaveBeenCalled();
      expect(repository.claimSubmission).toHaveBeenCalledExactlyOnceWith(
        first.id,
      );

      const secondResult = await execution.dispatch(second);
      expect(secondResult.outcome).toBeNull();
      expect(secondAdapter.execute).toHaveBeenCalledTimes(1);
      expect(secondAdapter.toRequest).toHaveBeenCalledExactlyOnceWith(
        secondResult,
      );
      expect(secondAdapter.lookup).not.toHaveBeenCalled();
      expect(firstAdapter.execute).toHaveBeenCalledTimes(1);
    } finally {
      await module.close();
    }
  });
});
