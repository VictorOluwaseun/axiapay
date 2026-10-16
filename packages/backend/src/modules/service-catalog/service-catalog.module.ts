import { Module } from '@nestjs/common';
import {
  DatabaseConnection,
  DatabaseModule,
} from '../../infrastructure/database/database.module.js';
import { SERVICE_CATALOG } from './service-catalog.tokens.js';
import { PostgresServiceCatalogRepository } from './repositories/postgres-service-catalog.repository.js';
import { ServiceCatalogService } from './services/service-catalog.service.js';

/** Export catalogue operations while keeping authoritative PostgreSQL persistence private. */
@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: SERVICE_CATALOG.repository,
      inject: [DatabaseConnection],
      useFactory: (connection: DatabaseConnection) =>
        new PostgresServiceCatalogRepository(connection.database),
    },
    ServiceCatalogService,
  ],
  exports: [ServiceCatalogService],
})
export class ServiceCatalogModule {}
