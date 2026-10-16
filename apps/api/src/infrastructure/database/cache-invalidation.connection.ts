import { Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

/** Isolate cache recovery from business transactions with one connection and bounded acquisition, SQL, lock and network waits. */
export class CacheInvalidationConnection<
  Database,
> implements OnApplicationShutdown {
  readonly database: Kysely<Database>;
  private readonly logger = new Logger(CacheInvalidationConnection.name);

  /** Borrow validated credentials; this pool handles only committed cache invalidations, never business mutations. */
  constructor(configuration: ConfigService, applicationName: string) {
    const pool = new Pool({
      connectionString: configuration.getOrThrow<string>('DATABASE_URL'),
      application_name: applicationName,
      max: 1,
      connectionTimeoutMillis: 250,
      statement_timeout: 250,
      lock_timeout: 100,
      query_timeout: 500,
      idleTimeoutMillis: 10_000,
    });
    pool.on('error', () => {
      this.logger.warn({
        event: `${applicationName.replaceAll('-', '_')}_database_unavailable`,
        recovery: 'durable_outbox_retry',
      });
    });
    this.database = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool,
      }),
    });
  }

  /** Close the recovery pool after the repository has stopped its bounded in-flight attempt. */
  async onApplicationShutdown(): Promise<void> {
    await this.database.destroy();
  }
}
