import type { BillAccountVerification } from '../ports/bill-account-verification.js';
import { Module, type DynamicModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { PaymentProviders } from '../ports/service-payment-provider.js';
import { PaymentError } from '../domain/payment.js';
import { ServicePaymentProcessor } from '../processors/service-payment.processor.js';
import { ServiceProcessorRouter } from '../processors/service-processor-router.js';
import { VtpassAirtimeAdapter } from './vtpass-airtime.adapter.js';
import { VtpassDataAdapter } from './vtpass-data.adapter.js';
import { VtpassTvSubscriptionAdapter } from './vtpass-tv-subscription.adapter.js';
import { VtpassElectricityAdapter } from './vtpass-electricity.adapter.js';
import { VtpassEducationAdapter } from './vtpass-education.adapter.js';
import { VtpassInsuranceAdapter } from './vtpass-insurance.adapter.js';
import {
  VtpassMerchantPaymentAdapter,
  type VtpassMerchantDefinitions,
} from './vtpass-merchant-payment.adapter.js';
import type { VtpassSettings } from './vtpass-client.js';

/** Private provider configuration and public first-party registration token for both API and independently deployed workers. */
export const VTPASS_PAYMENTS = Object.freeze({
  registrations: Symbol('VtpassPaymentRegistrations'),
  merchants: Symbol('VtpassMerchantDefinitions'),
});

/** Read already validated settings without constructing clients or issuing requests when the integration is absent. */
function vtpassSettings(configuration: ConfigService): VtpassSettings | null {
  const apiKey = configuration.get<string>('VTPASS_API_KEY');
  if (!apiKey) {
    return null;
  }
  const environment = configuration.getOrThrow<'sandbox' | 'live'>(
    'VTPASS_ENVIRONMENT',
  );
  return {
    apiKey,
    environment,
    publicKey: configuration.get<string>('VTPASS_PUBLIC_KEY'),
    secretKey: configuration.getOrThrow<string>('VTPASS_SECRET_KEY'),
    providerKey: `vtpass:${environment}:${configuration.getOrThrow<string>('VTPASS_PARTNER_ACCOUNT_ID')}`,
  };
}

/** Compose provider-specific protocols behind independent first-party processors, retaining the existing account/environment key for historical Airtime recovery. */
function vtpassRegistrations(
  configuration: ConfigService,
  merchants: VtpassMerchantDefinitions,
): PaymentProviders {
  const settings = vtpassSettings(configuration);
  if (!settings) {
    return Object.freeze({});
  }
  const television = new VtpassTvSubscriptionAdapter(settings);
  const electricity = new VtpassElectricityAdapter(settings);
  const education = new VtpassEducationAdapter(settings);
  const insurance = new VtpassInsuranceAdapter(settings);
  return Object.freeze({
    [settings.providerKey]: Object.freeze({
      partnerAccountId: configuration.getOrThrow<string>(
        'VTPASS_PARTNER_ACCOUNT_ID',
      ),
      feeAccountId: configuration.get<string>('VTPASS_FEE_ACCOUNT_ID') ?? null,
      adapter: new ServiceProcessorRouter({
        airtime: new ServicePaymentProcessor(
          'airtime',
          new VtpassAirtimeAdapter(settings),
        ),
        data: new ServicePaymentProcessor(
          'data',
          new VtpassDataAdapter(settings),
        ),
        tv: new ServicePaymentProcessor('tv', television),
        electricity: new ServicePaymentProcessor('electricity', electricity),
        education: new ServicePaymentProcessor('education', education),
        insurance: new ServicePaymentProcessor('insurance', insurance),
        merchant: new ServicePaymentProcessor(
          'merchant',
          new VtpassMerchantPaymentAdapter(settings, merchants),
        ),
      }),
      accountVerification: {
        /** Dispatch only non-purchasing account verification to the matching protocol; no generic merchant-name lookup is invented. */
        verify: async (
          input: Parameters<BillAccountVerification['verify']>[0],
        ) => {
          if (input.product.serviceType === 'tv') {
            return television.verify(input);
          }
          if (input.product.serviceType === 'electricity') {
            return electricity.verify(input);
          }
          throw new PaymentError('PAYMENT_UNAVAILABLE', {
            reason: 'SERVICE_NOT_SUPPORTED',
          });
        },
      },
      educationVerification: education,
      insuranceEligibility: insurance,
      insuranceInputOptions: insurance,
      documentRetrieval: insurance,
    }),
  });
}

/** Optional all-service VTpass composition. Unconfigured credentials, unsupported protocols and unpublished catalogue revisions never enable a purchase. */
@Module({})
export class VtpassPaymentsModule {
  /** Supply reviewed merchant mappings only when their service-specific payment/evidence contracts match this adapter; no network request or catalogue seeding runs at startup. */
  static register(
    merchants: VtpassMerchantDefinitions = Object.freeze({}),
  ): DynamicModule {
    return {
      module: VtpassPaymentsModule,
      imports: [ConfigModule],
      providers: [
        { provide: VTPASS_PAYMENTS.merchants, useValue: merchants },
        {
          provide: VTPASS_PAYMENTS.registrations,
          inject: [ConfigService, VTPASS_PAYMENTS.merchants],
          useFactory: vtpassRegistrations,
        },
      ],
      exports: [VTPASS_PAYMENTS.registrations],
    };
  }
}
