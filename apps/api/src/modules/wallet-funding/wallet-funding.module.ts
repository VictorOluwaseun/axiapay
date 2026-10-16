import { Module, type DynamicModule } from '@nestjs/common';
import { AuthenticationModule } from '../authentication/authentication.module.js';
import { WalletModule } from '@axiapay/payments-runtime/modules/wallets/wallet.module';
import {
  FundingCoreModule,
  type FundingModuleOptions,
} from './funding-core.module.js';
import { FundingService } from './services/funding.service.js';
import { WalletFundingService } from './services/wallet-funding.service.js';
import { WalletFundingController } from './controllers/wallet-funding.controller.js';

/** AxiaPay-owned HTTP contracts, customer authorization and ledger coordination, independent of optional external adapters. */
@Module({})
export class WalletFundingModule {
  /** Compose the same funding verifier for API and ledger operations without a cyclic module dependency. */
  static register(options: FundingModuleOptions = {}): DynamicModule {
    const core = FundingCoreModule.register(options);
    return {
      module: WalletFundingModule,
      imports: [
        AuthenticationModule,
        core,
        WalletModule.withFundingVerification({
          imports: [core],
          verifier: FundingService,
        }),
      ],
      providers: [WalletFundingService],
      controllers: [WalletFundingController],
      exports: [WalletFundingService],
    };
  }
}
