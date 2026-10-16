import { Module, type DynamicModule } from '@nestjs/common';
import type { PaymentsModuleOptions } from '@axiapay/backend/modules/payments/payments-core.module';
import { PaymentsRuntimeModule } from '@axiapay/backend/modules/payments/payments-runtime.module';
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
  static register(options: PaymentsModuleOptions = {}): DynamicModule {
    return {
      module: PaymentsModule,
      imports: [AuthenticationModule, PaymentsRuntimeModule.register(options)],
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
