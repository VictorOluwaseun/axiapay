import { Module, type DynamicModule } from '@nestjs/common';
import { AuthenticationModule } from '../authentication/authentication.module.js';
import { ServiceCatalogModule } from '../service-catalog/service-catalog.module.js';
import { WalletModule } from '../wallets/wallet.module.js';
import {
  PaymentsCoreModule,
  type PaymentsModuleOptions,
} from './payments-core.module.js';
import { PaymentExecutionService } from './services/payment-execution.service.js';
import { WalletPaymentService } from './services/wallet-payment.service.js';
import { PaymentsController } from './controllers/payments.controller.js';
import { ServiceCatalogController } from './controllers/service-catalog.controller.js';
import { BankTransferService } from './services/bank-transfer.service.js';
import { BankTransfersController } from './controllers/bank-transfers.controller.js';
import { BillAccountsController } from './controllers/bill-accounts.controller.js';

import { EducationInsuranceController } from './controllers/education-insurance.controller.js';
import { PaymentDocumentsController } from './controllers/payment-documents.controller.js';

/** Compose authenticated first-party purchase APIs and verifier-backed wallet operations with explicitly injected optional adapters. */
@Module({})
export class PaymentsModule {
  /** Share one payment core between HTTP orchestration and trusted ledger verification; no adapter is enabled by default. */
  static register(options: PaymentsModuleOptions = {}): DynamicModule {
    const core = PaymentsCoreModule.register(options);
    return {
      module: PaymentsModule,
      imports: [
        AuthenticationModule,
        ServiceCatalogModule,
        core,
        WalletModule.withPaymentOutcomeVerification({
          imports: [core],
          verifier: PaymentExecutionService,
        }),
      ],
      providers: [WalletPaymentService, BankTransferService],
      controllers: [
        PaymentsController,
        ServiceCatalogController,
        BillAccountsController,
        BankTransfersController,
        EducationInsuranceController,
        PaymentDocumentsController,
      ],
      exports: [WalletPaymentService, BankTransferService],
    };
  }
}
