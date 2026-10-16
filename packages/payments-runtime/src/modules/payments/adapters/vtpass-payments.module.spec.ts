import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { PaymentProviders } from '../ports/service-payment-provider.js';
import {
  VTPASS_PAYMENTS,
  VtpassPaymentsModule,
} from './vtpass-payments.module.js';
import { ServiceProcessorRouter } from '../processors/service-processor-router.js';
import {
  serviceInstruction,
  serviceProcessorCases,
  serviceProduct,
} from '../../../../tests/support/service-processor-fixture.js';

/** Compile real provider composition without importing an API, creating a pool, contacting a provider or publishing catalogue products. */
async function configuredModule(settings: Readonly<Record<string, unknown>>) {
  return Test.createTestingModule({
    imports: [VtpassPaymentsModule.register()],
  })
    .overrideProvider(ConfigService)
    .useValue(new ConfigService(settings))
    .compile();
}

describe('multi-service VTpass composition', () => {
  it('registers no provider when credentials are absent', async () => {
    const module = await configuredModule({});
    try {
      expect(module.get(VTPASS_PAYMENTS.registrations)).toEqual({});
    } finally {
      await module.close();
    }
  });
  it('retains the existing Airtime account key and privately composes category processors without startup I/O', async () => {
    const partnerAccountId = '00000000-0000-4000-8000-000000000001';
    const providerKey = `vtpass:sandbox:${partnerAccountId}`;
    const module = await configuredModule({
      VTPASS_API_KEY: 'test-api-key',
      VTPASS_SECRET_KEY: 'test-secret-key',
      VTPASS_PUBLIC_KEY: 'test-public-key',
      VTPASS_ENVIRONMENT: 'sandbox',
      VTPASS_PARTNER_ACCOUNT_ID: partnerAccountId,
    });
    try {
      const registrations = module.get<PaymentProviders>(
        VTPASS_PAYMENTS.registrations,
      );
      expect(Object.keys(registrations)).toEqual([providerKey]);
      const registration = registrations[providerKey]!;
      expect(registration.adapter).toBeInstanceOf(ServiceProcessorRouter);
      expect(registration).toMatchObject({
        partnerAccountId,
        feeAccountId: null,
      });
      for (const serviceType of serviceProcessorCases.filter(
        (category) => category !== 'merchant',
      )) {
        const payment = serviceInstruction(serviceType);
        expect(() =>
          registration.adapter.validate?.({
            scope: 'product',
            terms: { ...serviceProduct(payment), providerKey },
          }),
        ).not.toThrow();
      }
      const merchant = serviceInstruction('merchant');
      expect(() =>
        registration.adapter.validate?.({
          scope: 'product',
          terms: { ...serviceProduct(merchant), providerKey },
        }),
      ).toThrow();
      expect(registration.accountVerification).toBeDefined();
      expect(registration.educationVerification).toBeDefined();
      expect(registration.insuranceEligibility).toBeDefined();
      expect(registration.documentRetrieval).toBeDefined();
    } finally {
      await module.close();
    }
  });
});
