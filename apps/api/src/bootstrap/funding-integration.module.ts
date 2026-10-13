import { Module } from '@nestjs/common';
import { WalletFundingModule } from '../modules/wallet-funding/wallet-funding.module.js';
import {
  ProviderFundingModule,
  PROVIDER_FUNDING,
} from '../modules/wallet-funding/adapters/provider-funding.module.js';
import { FundingWebhookController } from '../modules/wallet-funding/adapters/funding-webhook.controller.js';

/** Composition root connects optional external adapters and authenticated callbacks to the AxiaPay funding contracts. */
@Module({
  imports: [
    ProviderFundingModule,
    WalletFundingModule.register({
      imports: [ProviderFundingModule],
      routes: { useExisting: PROVIDER_FUNDING.routes },
    }),
  ],
  controllers: [FundingWebhookController],
})
export class FundingIntegrationModule {}
