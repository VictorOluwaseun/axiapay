/** Verify configured VTpass adapters are injected into our processor without startup network I/O or implicit activation. */
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { DatabaseConnection } from '@axiapay/payments-runtime/infrastructure/database/database.module';
import { validateEnvironment } from '../../src/infrastructure/config/environment.js';
import { PaymentsCoreModule } from '@axiapay/payments-runtime/modules/payments/payments-core.module';
import {
  VtpassAirtimeModule,
  VTPASS_AIRTIME,
} from '@axiapay/payments-runtime/modules/payments/adapters/vtpass-airtime.module';
import { VtpassAirtimeAdapter } from '@axiapay/payments-runtime/modules/payments/adapters/vtpass-airtime.adapter';
import { PAYMENTS } from '@axiapay/payments-runtime/modules/payments/payments.tokens';
import type { PaymentProviders } from '@axiapay/payments-runtime/modules/payments/ports/service-payment-provider';
import { ServicePaymentProcessor } from '@axiapay/payments-runtime/modules/payments/processors/service-payment.processor';
import {
  vtpassDelivered,
  vtpassInstruction,
  vtpassProduct,
  vtpassTestAccountId,
} from '../../../../packages/payments-runtime/tests/support/vtpass-airtime-fixture.js';

/** Compile the actual payment feature with validated isolated configuration and a nonconnecting pool placeholder. */
async function configuredModule(partnerSettings: Record<string, unknown>) {
  const configuration = validateEnvironment({
    AUTH_CODE_SECRET: '11'.repeat(32),
    DATABASE_URL: 'postgresql://test:test@localhost/test',
    REDIS_CACHE_URL: 'redis://localhost:56379',
    REDIS_QUEUE_URL: 'redis://localhost:56380',
    ...partnerSettings,
  });
  return Test.createTestingModule({
    imports: [
      PaymentsCoreModule.register({
        featurePolicy: { useValue: { isEnabled: async () => true } },
        imports: [VtpassAirtimeModule],
        fulfilment: { useExisting: VTPASS_AIRTIME.registrations },
      }),
    ],
  })
    .overrideProvider(ConfigService)
    .useValue(new ConfigService(configuration))
    .overrideProvider(DatabaseConnection)
    .useValue({ database: {} })
    .compile();
}

describe('VTpass airtime dependency injection', () => {
  it('leaves payment providers empty when credentials are absent', async () => {
    const module = await configuredModule({});
    try {
      expect(module.get<PaymentProviders>(PAYMENTS.providers)).toEqual({});
    } finally {
      await module.close();
    }
  });

  it.each(['sandbox', 'live'] as const)(
    'constructs the %s processor from an injected adapter and immutable account routing',
    async (environment) => {
      const module = await configuredModule({
        VTPASS_ENVIRONMENT: environment,
        VTPASS_API_KEY: 'test-static-key',
        VTPASS_SECRET_KEY: 'test-secret-key',
        VTPASS_PARTNER_ACCOUNT_ID: vtpassTestAccountId,
      });
      const initial = vtpassInstruction();
      const providerKey = `vtpass:${environment}:${vtpassTestAccountId}`;
      const payment = { ...initial, quote: { ...initial.quote, providerKey } };
      const execute = vi
        .spyOn(VtpassAirtimeAdapter.prototype, 'execute')
        .mockResolvedValueOnce(vtpassDelivered(payment));
      try {
        const providers = module.get<PaymentProviders>(PAYMENTS.providers);
        expect(Object.keys(providers)).toEqual([providerKey]);
        const registration = providers[providerKey]!;
        expect(registration.adapter).toBeInstanceOf(ServicePaymentProcessor);
        expect(registration.partnerAccountId).toBe(vtpassTestAccountId);
        expect(registration.feeAccountId).toBeNull();
        expect(() =>
          registration.adapter.validate?.({
            scope: 'product',
            terms: vtpassProduct(payment),
          }),
        ).not.toThrow();
        expect(execute).not.toHaveBeenCalled();
        expect((await registration.adapter.submit(payment)).outcome).toBe(
          'succeeded',
        );
        expect(execute).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ serviceID: 'mtn', phone: '08011111111' }),
        );
      } finally {
        execute.mockRestore();
        await module.close();
      }
    },
  );
});
