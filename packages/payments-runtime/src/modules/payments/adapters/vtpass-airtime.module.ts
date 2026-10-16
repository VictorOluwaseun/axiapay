import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AirtimeProcessor } from '../processors/airtime.processor.js';
import type { PaymentProviders } from '../ports/service-payment-provider.js';
import { VtpassAirtimeAdapter } from './vtpass-airtime.adapter.js';

/** Private outbound adapter binding and exported first-party registrations; no credentials or SDK types enter the payments core. */
export const VTPASS_AIRTIME = Object.freeze({
  adapter: Symbol('VtpassAirtimeAdapter'),
  registrations: Symbol('VtpassAirtimeRegistrations'),
});

/** Construct an adapter only after complete validated credentials and ledger routing have been explicitly configured. No HTTP request runs at startup. */
function configuredAdapter(
  configuration: ConfigService,
): VtpassAirtimeAdapter | null {
  const apiKey = configuration.get<string>('VTPASS_API_KEY');
  if (!apiKey) {
    return null;
  }
  const environment = configuration.getOrThrow<'sandbox' | 'live'>(
    'VTPASS_ENVIRONMENT',
  );
  const partnerAccountId = configuration.getOrThrow<string>(
    'VTPASS_PARTNER_ACCOUNT_ID',
  );
  return new VtpassAirtimeAdapter({
    environment,
    providerKey: `vtpass:${environment}:${partnerAccountId}`,
    apiKey,
    secretKey: configuration.getOrThrow<string>('VTPASS_SECRET_KEY'),
  });
}

/** Inject the provider adapter into AxiaPay's processor at composition, retaining one immutable account/environment routing key and private ledger accounts. */
function configuredRegistrations(
  adapter: VtpassAirtimeAdapter | null,
  configuration: ConfigService,
): PaymentProviders {
  if (!adapter) {
    return Object.freeze({});
  }
  return Object.freeze({
    [adapter.providerKey]: Object.freeze({
      adapter: new AirtimeProcessor(adapter),
      partnerAccountId: configuration.getOrThrow<string>(
        'VTPASS_PARTNER_ACCOUNT_ID',
      ),
      feeAccountId: configuration.get<string>('VTPASS_FEE_ACCOUNT_ID') ?? null,
    }),
  });
}

/** Optional VTpass airtime integration; services consume only the existing PaymentProviders contract. */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: VTPASS_AIRTIME.adapter,
      inject: [ConfigService],
      useFactory: configuredAdapter,
    },
    {
      provide: VTPASS_AIRTIME.registrations,
      inject: [VTPASS_AIRTIME.adapter, ConfigService],
      useFactory: configuredRegistrations,
    },
  ],
  exports: [VTPASS_AIRTIME.registrations],
})
export class VtpassAirtimeModule {}
