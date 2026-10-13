import { DeviceAuthenticationController } from './controllers/device-authentication.controller.js';
import { DeviceAuthenticationService } from './services/device-authentication.service.js';
import { NodeDeviceSignatures } from './security/node-device-signatures.js';
import { PostgresDeviceAuthenticationRepository } from './repositories/postgres-device-authentication.repository.js';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  DatabaseModule,
  DatabaseConnection,
} from '../../infrastructure/database/database.module.js';
import { AUTHENTICATION } from './authentication.tokens.js';
import type { AuthenticationRepository } from './repositories/contracts/authentication.repository.js';
import type {
  AuthenticationClock,
  AuthenticationSecrets,
} from './ports/authentication.ports.js';
import { PostgresAuthenticationRepository } from './repositories/postgres-authentication.repository.js';
import { NodeAuthenticationSecrets } from './security/node-authentication-secrets.js';
import { ArgonPasswordHasher } from './security/argon-password-hasher.js';
import { MailpitAuthenticationCodeDelivery } from './providers/mailpit-authentication-code-delivery.js';
import { AuthenticationController } from './controllers/authentication.controller.js';
import { AuthenticationGuard } from './guards/authentication.guard.js';
import { AuthenticationCodeService } from './services/authentication-code.service.js';
import { AuthenticationService } from './services/authentication.service.js';
import { AuthenticationRateLimiter } from './services/authentication-rate-limiter.service.js';

/** Compose explicit Nest providers; export feature operations and guards, keeping persistence private. */
@Module({
  imports: [ConfigModule, DatabaseModule],
  controllers: [AuthenticationController, DeviceAuthenticationController],
  providers: [
    {
      provide: AUTHENTICATION.devices,
      inject: [DatabaseConnection],
      useFactory: (connection: DatabaseConnection) =>
        new PostgresDeviceAuthenticationRepository(connection.database),
    },
    {
      provide: AUTHENTICATION.deviceSignatures,
      useClass: NodeDeviceSignatures,
    },
    DeviceAuthenticationService,
    {
      provide: AUTHENTICATION.repository,
      inject: [DatabaseConnection],
      useFactory: (connection: DatabaseConnection) =>
        new PostgresAuthenticationRepository(connection.database),
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
