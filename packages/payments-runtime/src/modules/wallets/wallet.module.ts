import {
  Module,
  type DynamicModule,
  type ModuleMetadata,
  type Type,
} from '@nestjs/common';
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

/** Compose transport-independent wallet services; funding and settlement require explicitly registered verifiers. */
@Module({
  imports: [DatabaseModule],
  providers: [
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
})
export class WalletModule {
  /** Bind a trusted payment-outcome service exported by a separate core module, keeping wallet persistence private and avoiding feature cycles. */
  static withPaymentOutcomeVerification(options: {
    imports: NonNullable<ModuleMetadata['imports']>;
    verifier: Type<PaymentOutcomeVerification>;
  }): DynamicModule {
    return {
      module: WalletModule,
      imports: options.imports,
      providers: [
        { provide: WALLET.paymentOutcome, useExisting: options.verifier },
      ],
    };
  }
  /** Bind a lifecycle-managed verifier exported by another Nest module without exposing wallet persistence or introducing a cycle. */
  static withFundingVerification(options: {
    imports: NonNullable<ModuleMetadata['imports']>;
    verifier: Type<FundingVerification>;
  }): DynamicModule {
    return {
      module: WalletModule,
      imports: options.imports,
      providers: [{ provide: WALLET.funding, useExisting: options.verifier }],
    };
  }
  /** Register verified provider adapters and the shared database owner. No permissive verification defaults exist. */
  static register(verification: {
    readonly funding: FundingVerification;
    readonly paymentOutcome: PaymentOutcomeVerification;
  }): DynamicModule {
    return {
      module: WalletModule,
      providers: [
        { provide: WALLET.funding, useValue: verification.funding },
        {
          provide: WALLET.paymentOutcome,
          useValue: verification.paymentOutcome,
        },
      ],
    };
  }
}
