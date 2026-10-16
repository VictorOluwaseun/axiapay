import {
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { createDatabase } from './create-database.js';

/** Own the shared Kysely pool; only repository/data-source composition may access this connection. */
@Injectable()
export class DatabaseConnection implements OnApplicationShutdown {
  readonly database;
  /** Construct a lazy bounded pool, shared by features importing DatabaseModule. */
  constructor(@Inject(ConfigService) configuration: ConfigService) {
    this.database = createDatabase(
      configuration.getOrThrow<string>('DATABASE_URL'),
    );
  }
  /** Close the shared pool after background workers have drained in onModuleDestroy. */
  async onApplicationShutdown(): Promise<void> {
    await this.database.destroy();
  }
}

/** Export a single pool owner through Nest module DI instead of per-feature resource containers. */
@Module({
  imports: [ConfigModule],
  providers: [DatabaseConnection],
  exports: [DatabaseConnection],
})
export class DatabaseModule {}
