import { Module, type DynamicModule } from '@nestjs/common';
import {
  DatabaseConnection,
  DatabaseModule,
} from '../../infrastructure/database/database.module.js';
import { ServiceCatalogModule } from '../service-catalog/service-catalog.module.js';
import { WalletModule } from '../wallets/wallet.module.js';
import {
  PaymentsCoreModule,
  type PaymentsModuleOptions,
} from './payments-core.module.js';
import { PAYMENTS } from './payments.tokens.js';
import { PostgresPaymentRecoveryRepository } from './repositories/postgres-payment-recovery.repository.js';
import { PaymentExecutionService } from './services/payment-execution.service.js';
import { PaymentRecoveryService } from './services/payment-recovery.service.js';
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
        DatabaseModule,
        ServiceCatalogModule,
        core,
        WalletModule.withPaymentOutcomeVerification({
          imports: [core],
          verifier: PaymentExecutionService,
        }),
      ],
      providers: [
        WalletPaymentService,
        {
          provide: PAYMENTS.recoveryRepository,
          inject: [DatabaseConnection],
          /** Keep recovery SQL private to the shared payment feature's composition boundary. */
          useFactory: (connection: DatabaseConnection) =>
            new PostgresPaymentRecoveryRepository(connection.database),
        },
        PaymentRecoveryService,
      ],
      exports: [
        PaymentsCoreModule,
        ServiceCatalogModule,
        WalletPaymentService,
        PaymentRecoveryService,
      ],
    };
  }
}
