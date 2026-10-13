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
import { FUNDING } from './funding.tokens.js';
import type { FundingRoute } from './ports/funding-adapter.js';
import { PostgresFundingRepository } from './repositories/postgres-funding.repository.js';
import { FundingService } from './services/funding.service.js';

/** Explicit DI composition for outbound funding capabilities; callers can register any conforming adapter or none. */
export interface FundingModuleOptions {
  readonly imports?: ModuleMetadata['imports'];
  readonly routes?:
    | Omit<FactoryProvider<readonly FundingRoute[]>, 'provide'>
    | Omit<ValueProvider<readonly FundingRoute[]>, 'provide'>
    | Omit<ExistingProvider, 'provide'>;
}

/** Own persistence and provider-neutral workflows. Concrete adapters are supplied by the application composition root. */
@Module({})
export class FundingCoreModule {
  /** An absent binding list fails closed; no concrete provider or configuration dependency is imported by this module. */
  static register(options: FundingModuleOptions = {}): DynamicModule {
    return {
      module: FundingCoreModule,
      imports: [DatabaseModule, ...(options.imports ?? [])],
      providers: [
        {
          provide: FUNDING.repository,
          inject: [DatabaseConnection],
          useFactory: (connection: DatabaseConnection) =>
            new PostgresFundingRepository(connection.database),
        },
        { provide: FUNDING.routes, ...(options.routes ?? { useValue: [] }) },
        FundingService,
      ],
      exports: [FundingService],
    };
  }
}
