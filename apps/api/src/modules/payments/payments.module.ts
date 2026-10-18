import { RemoteConfigModule } from '../remote-config/remote-config.module.js';
import { RemoteConfigService } from '../remote-config/services/remote-config.service.js';
import { Module, type DynamicModule } from '@nestjs/common';
import type { PaymentsModuleOptions } from '@axiapay/payments-runtime/modules/payments/payments-core.module';
import { PaymentsRuntimeModule } from '@axiapay/payments-runtime/modules/payments/payments-runtime.module';
import { AuthenticationModule } from '../authentication/authentication.module.js';
import { PaymentsController } from './controllers/payments.controller.js';
import { ServiceCatalogController } from './controllers/service-catalog.controller.js';
import { BankTransferService } from './services/bank-transfer.service.js';
import { BankTransfersController } from './controllers/bank-transfers.controller.js';
import { BillAccountsController } from './controllers/bill-accounts.controller.js';
import { EducationInsuranceController } from './controllers/education-insurance.controller.js';
import { PaymentDocumentsController } from './controllers/payment-documents.controller.js';

/** Own authenticated HTTP delivery; shared financial workflows are composed without starting background consumers. */
@Module({})
export class PaymentsModule {
  /** Bind existing purchase routes to the shared payment runtime and explicitly selected provider adapters. */
  static register(
    options: Omit<PaymentsModuleOptions, 'featurePolicy'> = {},
  ): DynamicModule {
    return {
      module: PaymentsModule,
      imports: [
        AuthenticationModule,
        PaymentsRuntimeModule.register({
          ...options,
          imports: [...(options.imports ?? []), RemoteConfigModule],
          featurePolicy: { useExisting: RemoteConfigService },
        }),
      ],
      providers: [BankTransferService],
      controllers: [
        PaymentsController,
        ServiceCatalogController,
        BillAccountsController,
        BankTransfersController,
        EducationInsuranceController,
        PaymentDocumentsController,
      ],
      exports: [PaymentsRuntimeModule, BankTransferService],
    };
  }
}
