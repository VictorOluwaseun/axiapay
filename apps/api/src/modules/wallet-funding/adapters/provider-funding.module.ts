import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { FundingEnvironment } from '../domain/funding.js';
import type { FundingRoute } from '../ports/funding-adapter.js';
import { PaystackFundingGateway } from './paystack-funding.gateway.js';
import { OpayFundingGateway } from './opay-funding.gateway.js';

/** Private composition tokens for optional retained integrations; the funding core depends only on its own routes token. */
export const PROVIDER_FUNDING = Object.freeze({
  clients: Symbol('ProviderFundingClients'),
  routes: Symbol('ProviderFundingRoutes'),
});

/** Provider-specific callback verifiers; raw HTTP authentication never enters the core outbound capability port. */
export interface ProviderFundingClients {
  readonly opay?: OpayFundingGateway;
  readonly paystack?: PaystackFundingGateway;
}

/** Compose optional partner capabilities from validated configuration; absent keys never enable a simulated funding path. */
function configuredPartners(
  configuration: ConfigService,
): ProviderFundingClients {
  const environment = configuration.getOrThrow<FundingEnvironment>(
    'FUNDING_ENVIRONMENT',
  );
  const returnUrl = configuration.get<string>('FUNDING_RETURN_URL') ?? '';
  const paystackSecret = configuration.get<string>('PAYSTACK_SECRET_KEY');
  const opaySecret = configuration.get<string>('OPAY_SECRET_KEY');
  return {
    paystack: paystackSecret
      ? new PaystackFundingGateway(
          environment,
          configuration.getOrThrow<string>('PAYSTACK_LEDGER_ACCOUNT_ID'),
          paystackSecret,
          returnUrl,
        )
      : undefined,
    opay: opaySecret
      ? new OpayFundingGateway(
          environment,
          configuration.getOrThrow<string>('OPAY_LEDGER_ACCOUNT_ID'),
          configuration.getOrThrow<string>('OPAY_MERCHANT_ID'),
          configuration.getOrThrow<string>('OPAY_PUBLIC_KEY'),
          opaySecret,
          returnUrl,
          configuration.getOrThrow<string>('OPAY_WEBHOOK_URL'),
        )
      : undefined,
  };
}

/** Advertise optional hosted checkout capabilities; these names and numeric encoding limits belong to adapter composition. */
function configuredRoutes(
  clients: ProviderFundingClients,
): readonly FundingRoute[] {
  return Object.entries(clients).flatMap(([adapterId, adapter]) =>
    adapter
      ? [
          {
            acceptsNewRequests: true,
            adapterId,
            adapter,
            option: {
              id: `${adapterId}-checkout`,
              displayName:
                adapterId === 'opay' ? 'OPay checkout' : 'Paystack checkout',
              currency: 'NGN',
              minimumAmountMinorUnits: 1n,
              maximumAmountMinorUnits:
                adapterId === 'opay'
                  ? BigInt(Number.MAX_SAFE_INTEGER)
                  : 9223372036854775807n,
            },
          },
        ]
      : [],
  );
}

/** Compose dormant OPay/Paystack adapters from optional configuration; no sandbox or simulated credit is enabled implicitly. */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: PROVIDER_FUNDING.clients,
      inject: [ConfigService],
      useFactory: configuredPartners,
    },
    {
      provide: PROVIDER_FUNDING.routes,
      inject: [PROVIDER_FUNDING.clients],
      useFactory: configuredRoutes,
    },
  ],
  exports: [PROVIDER_FUNDING.clients, PROVIDER_FUNDING.routes],
})
export class ProviderFundingModule {}
