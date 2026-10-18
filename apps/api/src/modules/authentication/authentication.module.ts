import { DeviceAuthenticationController } from './controllers/device-authentication.controller.js';
import { DeviceAuthenticationService } from './services/device-authentication.service.js';
import { NodeDeviceSignatures } from './security/node-device-signatures.js';
import { PostgresDeviceAuthenticationRepository } from './repositories/postgres-device-authentication.repository.js';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  DatabaseModule,
  DatabaseConnection,
} from '@axiapay/payments-runtime/infrastructure/database/database.module';
import { AUTHENTICATION } from './authentication.tokens.js';
import type { AuthenticationRepository } from './repositories/contracts/authentication.repository.js';
import type {
  AuthenticationClock,
  AuthenticationSecrets,
} from './ports/authentication.ports.js';
import { AuthenticationRepositoryImpl } from './repositories/authentication.repository.impl.js';
import { RedisCacheConnection } from '../../infrastructure/redis/redis-cache-connection.js';
import { RedisSessionIdentityCache } from './data-sources/redis-session-identity-cache.js';
import type { SessionIdentityCache } from './repositories/contracts/session-identity-cache.js';
import { PostgresSessionCacheInvalidationRepository } from './repositories/postgres-session-cache-invalidation.repository.js';
import type { SessionCacheInvalidationRepository } from './repositories/contracts/session-cache-invalidation.repository.js';
import { PostgresCodeRedemptionRepository } from './repositories/postgres-code-redemption.repository.js';
import { NodeAuthenticationSecrets } from './security/node-authentication-secrets.js';
import { ArgonPasswordHasher } from './security/argon-password-hasher.js';
import { MailpitAuthenticationCodeDelivery } from './providers/mailpit-authentication-code-delivery.js';
import { AuthenticationController } from './controllers/authentication.controller.js';
import { AuthenticationGuard } from './guards/authentication.guard.js';
import { AuthenticationCodeService } from './services/authentication-code.service.js';
import { AuthenticationService } from './services/authentication.service.js';
import { AuthenticationRateLimiter } from './services/authentication-rate-limiter.service.js';
import { SessionCacheInvalidationConnection } from '../../infrastructure/database/session-cache-invalidation.connection.js';
import { RemoteConfigModule } from '../remote-config/remote-config.module.js';

/** Compose explicit Nest providers; export feature operations and guards, keeping persistence private. */
@Module({
  imports: [ConfigModule, DatabaseModule, RemoteConfigModule],
  controllers: [AuthenticationController, DeviceAuthenticationController],
  providers: [
    RedisCacheConnection,
    SessionCacheInvalidationConnection,
    {
      provide: AUTHENTICATION.sessionIdentityCache,
      inject: [RedisCacheConnection, ConfigService],
      useFactory: (
        connection: RedisCacheConnection,
        configuration: ConfigService,
      ) =>
        new RedisSessionIdentityCache(
          connection,
          configuration.getOrThrow<string>('AUTH_CODE_SECRET'),
        ),
    },
    {
      provide: AUTHENTICATION.sessionCacheInvalidations,
      inject: [
        SessionCacheInvalidationConnection,
        AUTHENTICATION.sessionIdentityCache,
      ],
      useFactory: (
        connection: SessionCacheInvalidationConnection,
        cache: SessionIdentityCache,
      ) =>
        new PostgresSessionCacheInvalidationRepository(
          connection.database,
          cache,
        ),
    },
    {
      provide: AUTHENTICATION.codeRedemption,
      inject: [DatabaseConnection, AUTHENTICATION.sessionCacheInvalidations],
      useFactory: (
        connection: DatabaseConnection,
        invalidations: SessionCacheInvalidationRepository,
      ) =>
        new PostgresCodeRedemptionRepository(
          connection.database,
          invalidations,
        ),
    },
    {
      provide: AUTHENTICATION.devices,
      inject: [DatabaseConnection, AUTHENTICATION.sessionCacheInvalidations],
      useFactory: (
        connection: DatabaseConnection,
        invalidations: SessionCacheInvalidationRepository,
      ) =>
        new PostgresDeviceAuthenticationRepository(
          connection.database,
          invalidations,
        ),
    },
    {
      provide: AUTHENTICATION.deviceSignatures,
      useClass: NodeDeviceSignatures,
    },
    DeviceAuthenticationService,
    {
      provide: AUTHENTICATION.repository,
      inject: [
        DatabaseConnection,
        AUTHENTICATION.sessionIdentityCache,
        AUTHENTICATION.sessionCacheInvalidations,
      ],
      useFactory: (
        connection: DatabaseConnection,
        cache: SessionIdentityCache,
        invalidations: SessionCacheInvalidationRepository,
      ) =>
        new AuthenticationRepositoryImpl(
          connection.database,
          cache,
          invalidations,
        ),
    },
    { provide: AUTHENTICATION.passwords, useClass: ArgonPasswordHasher },
    {
      provide: AUTHENTICATION.secrets,
      inject: [ConfigService],
      useFactory: (configuration: ConfigService) =>
        new NodeAuthenticationSecrets(
          configuration.getOrThrow<string>('AUTH_CODE_SECRET'),
        ),
    },
    {
      provide: AUTHENTICATION.codeDelivery,
      inject: [ConfigService],
      useFactory: (configuration: ConfigService) =>
        new MailpitAuthenticationCodeDelivery(
          configuration.getOrThrow<string>('AUTH_MAILPIT_URL'),
        ),
    },
    {
      provide: AUTHENTICATION.clock,
      useFactory: (): AuthenticationClock => ({
        /** Read current UTC time; tests can replace this port without global timers. */ now: () =>
          new Date(),
      }),
    },
    {
      provide: AuthenticationRateLimiter,
      inject: [
        AUTHENTICATION.repository,
        AUTHENTICATION.secrets,
        AUTHENTICATION.clock,
      ],
      useFactory: (
        repository: AuthenticationRepository,
        secrets: AuthenticationSecrets,
        clock: AuthenticationClock,
      ) => new AuthenticationRateLimiter(repository, secrets, clock),
    },
    AuthenticationCodeService,
    AuthenticationService,
    AuthenticationGuard,
  ],
  exports: [
    AuthenticationService,
    AuthenticationGuard,
    DeviceAuthenticationService,
  ],
})
export class AuthenticationModule {}
