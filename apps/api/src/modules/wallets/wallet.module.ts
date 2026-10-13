import { Module, type DynamicModule } from '@nestjs/common';
import {
  DatabaseModule,
  DatabaseConnection,
} from '../../infrastructure/database/database.module.js';
import type {
  FundingVerification,
  PaymentOutcomeVerification,
} from './ports/wallet-verification.js';
import { WalletPostgresDataSource } from './data-sources/postgres/wallet.postgres.data-source.js';
import { WalletRepositoryImpl } from './repositories/wallet.repository.impl.js';
import { WALLET } from './wallet.tokens.js';
import { WalletReservationService } from './services/wallet-reservation.service.js';
import { WalletService } from './services/wallet.service.js';

/** Compose wallet operations only when trusted integration verifiers are supplied; no public money routes are registered. */
@Module({})
export class WalletModule {
  /** Register verified provider adapters and the shared database owner. No permissive verification defaults exist. */
  static register(verification: {
    readonly funding: FundingVerification;
    readonly paymentOutcome: PaymentOutcomeVerification;
  }): DynamicModule {
    return {
      module: WalletModule,
      imports: [DatabaseModule],
      providers: [
        { provide: WALLET.funding, useValue: verification.funding },
        {
          provide: WALLET.paymentOutcome,
          useValue: verification.paymentOutcome,
        },
        {
          provide: WalletPostgresDataSource,
          inject: [DatabaseConnection],
          useFactory: (connection: DatabaseConnection) =>
            new WalletPostgresDataSource(connection.database),
        },
        {
          provide: WALLET.repository,
          inject: [WalletPostgresDataSource],
          useFactory: (source: WalletPostgresDataSource) =>
            new WalletRepositoryImpl(source),
        },
        WalletReservationService,
        WalletService,
      ],
      exports: [WalletService],
    };
  }
}
