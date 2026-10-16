import { Module, type DynamicModule } from '@nestjs/common';
import { ServiceCatalogModule } from '../service-catalog/service-catalog.module.js';
import { WalletModule } from '../wallets/wallet.module.js';
import {
  PaymentsCoreModule,
  type PaymentsModuleOptions,
} from './payments-core.module.js';
import { PaymentExecutionService } from './services/payment-execution.service.js';
import { WalletPaymentService } from './services/wallet-payment.service.js';

/** Compose shared payment workflows and ledger verification without HTTP controllers, authentication or queue consumers. */
@Module({})
export class PaymentsRuntimeModule {
  /** Use the same provider contracts and database-backed financial rules in independently deployed API and worker processes. */
  static register(options: PaymentsModuleOptions = {}): DynamicModule {
    const core = PaymentsCoreModule.register(options);
    return {
      module: PaymentsRuntimeModule,
      imports: [
        ServiceCatalogModule,
        core,
        WalletModule.withPaymentOutcomeVerification({
          imports: [core],
          verifier: PaymentExecutionService,
        }),
      ],
      providers: [WalletPaymentService],
      exports: [
        PaymentsCoreModule,
        ServiceCatalogModule,
        WalletPaymentService,
      ],
    };
  }
}
