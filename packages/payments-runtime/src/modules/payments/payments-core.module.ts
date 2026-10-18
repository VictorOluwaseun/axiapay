import {
  Module,
  type DynamicModule,
  type ModuleMetadata,
  type FactoryProvider,
  type ValueProvider,
  type ExistingProvider,
} from '@nestjs/common';
import {
  DatabaseConnection,
  DatabaseModule,
} from '../../infrastructure/database/database.module.js';
import { ServiceCatalogModule } from '../service-catalog/service-catalog.module.js';
import type { PaymentFeaturePolicy } from './ports/payment-feature-policy.js';
import { PAYMENTS } from './payments.tokens.js';
import { PostgresPaymentRepository } from './repositories/postgres-payment.repository.js';
import { PaymentExecutionService } from './services/payment-execution.service.js';
import { PaymentQuoteService } from './services/payment-quote.service.js';
import { BankBeneficiaryService } from './services/bank-beneficiary.service.js';
import { BillAccountService } from './services/bill-account.service.js';
import { EducationRecipientService } from './services/education-recipient.service.js';
import { InsuranceApplicationService } from './services/insurance-application.service.js';
import { PaymentDocumentService } from './services/payment-document.service.js';
import type { PaymentProviders } from './ports/service-payment-provider.js';

/** Explicit application composition for optional adapter registrations; provider SDKs and credentials remain outside this feature core. */
export interface PaymentsModuleOptions {
  readonly imports?: ModuleMetadata['imports'];
  readonly featurePolicy?:
    | Omit<FactoryProvider<PaymentFeaturePolicy>, 'provide'>
    | Omit<ValueProvider<PaymentFeaturePolicy>, 'provide'>
    | Omit<ExistingProvider, 'provide'>;
  readonly fulfilment?:
    | Omit<FactoryProvider<PaymentProviders>, 'provide'>
    | Omit<ValueProvider<PaymentProviders>, 'provide'>
    | Omit<ExistingProvider, 'provide'>;
}

/** Keep repositories and adapter registrations private, exporting review/execution operations and trusted wallet verification only. */
@Module({})
export class PaymentsCoreModule {
  /** Absent adapter bindings fail closed; root composition can inject value, factory or existing-provider registrations. */
  static register(options: PaymentsModuleOptions = {}): DynamicModule {
    return {
      module: PaymentsCoreModule,
      imports: [
        DatabaseModule,
        ServiceCatalogModule,
        ...(options.imports ?? []),
      ],
      providers: [
        {
          provide: PAYMENTS.repository,
          inject: [DatabaseConnection],
          useFactory: (connection: DatabaseConnection) =>
            new PostgresPaymentRepository(connection.database),
        },
        {
          provide: PAYMENTS.providers,
          ...(options.fulfilment ?? { useValue: Object.freeze({}) }),
        },
        {
          provide: PAYMENTS.clock,
          useValue: Object.freeze({
            /** Use the current UTC instant for new review terms. */
            now: () => new Date(),
          }),
        },
        {
          provide: PAYMENTS.featurePolicy,
          ...(options.featurePolicy ?? {
            useValue: { isEnabled: async () => false },
          }),
        },
        PaymentExecutionService,
        PaymentQuoteService,
        BillAccountService,
        BankBeneficiaryService,
        EducationRecipientService,
        InsuranceApplicationService,
        PaymentDocumentService,
      ],
      exports: [
        {
          provide: PAYMENTS.featurePolicy,
          ...(options.featurePolicy ?? {
            useValue: { isEnabled: async () => false },
          }),
        },
        PaymentExecutionService,
        PaymentQuoteService,
        BillAccountService,
        BankBeneficiaryService,
        EducationRecipientService,
        InsuranceApplicationService,
        PaymentDocumentService,
      ],
    };
  }
}
