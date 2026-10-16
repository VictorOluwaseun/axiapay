import { Module, type DynamicModule } from '@nestjs/common';
import { AuthenticationModule } from '../authentication/authentication.module.js';
import { WalletModule } from '@axiapay/backend/modules/wallets/wallet.module';
import {
  ConversionCoreModule,
  type ConversionModuleOptions,
} from './conversion-core.module.js';
import { ConversionService } from './services/conversion.service.js';
import { WalletConversionService } from './services/wallet-conversion.service.js';
import { AirtimeConversionsController } from './controllers/airtime-conversions.controller.js';

/** Compose authenticated first-party APIs and inbound ledger credit without a dependency cycle or concrete providers. */
@Module({})
export class AirtimeConversionModule {
  /** The wallet consumes the same saved-proof verifier as HTTP workflows; adapter bindings are optional and explicit. */
  static register(options: ConversionModuleOptions = {}): DynamicModule {
    const core = ConversionCoreModule.register(options);
    return {
      module: AirtimeConversionModule,
      imports: [
        AuthenticationModule,
        core,
        WalletModule.withFundingVerification({
          imports: [core],
          verifier: ConversionService,
        }),
      ],
      providers: [WalletConversionService],
      controllers: [AirtimeConversionsController],
      exports: [WalletConversionService],
    };
  }
}
