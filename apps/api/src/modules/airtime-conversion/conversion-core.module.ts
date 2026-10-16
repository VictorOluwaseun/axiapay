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
} from '@axiapay/backend/infrastructure/database/database.module';
import { CONVERSION } from './conversion.tokens.js';
import type { ConversionRoute } from './ports/airtime-conversion-provider.js';
import { PostgresConversionRepository } from './repositories/postgres-conversion.repository.js';
import { ConversionService } from './services/conversion.service.js';

/** Explicit route injection for future adapters; no provider SDK, secret, network, rate or fee is assumed by core. */
export interface ConversionModuleOptions {
  readonly imports?: ModuleMetadata['imports'];
  readonly routes?:
    | Omit<FactoryProvider<readonly ConversionRoute[]>, 'provide'>
    | Omit<ValueProvider<readonly ConversionRoute[]>, 'provide'>
    | Omit<ExistingProvider, 'provide'>;
}

/** Own conversion persistence and trusted receipt verification; exports workflow capability while storage stays private. */
@Module({})
export class ConversionCoreModule {
  /** Empty configuration fails closed. The lifecycle-managed SQL pool is injected only into repository infrastructure. */
  static register(options: ConversionModuleOptions = {}): DynamicModule {
    return {
      module: ConversionCoreModule,
      imports: [DatabaseModule, ...(options.imports ?? [])],
      providers: [
        {
          provide: CONVERSION.repository,
          inject: [DatabaseConnection],
          useFactory: (connection: DatabaseConnection) =>
            new PostgresConversionRepository(connection.database),
        },
        { provide: CONVERSION.routes, ...(options.routes ?? { useValue: [] }) },
        ConversionService,
      ],
      exports: [ConversionService],
    };
  }
}
