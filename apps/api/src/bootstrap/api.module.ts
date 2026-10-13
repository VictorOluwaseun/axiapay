import { RequestValidationModule } from './request-validation.module.js';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { AuthenticationModule } from '../modules/authentication/authentication.module.js';
import { WalletHttpModule } from '../modules/wallets/wallet-http.module.js';
import { HealthModule } from '../modules/health/health.module.js';
import { validateEnvironment } from '../infrastructure/config/environment.js';
import { createLoggerOptions } from '../infrastructure/observability/logger-options.js';

/** Compose feature modules, validation, configuration, and diagnostics; feature workflows are added through modules. */
@Module({
  imports: [
    ConfigModule.forRoot({ validate: validateEnvironment }),
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: createLoggerOptions,
    }),
    RequestValidationModule,
    HealthModule,
    AuthenticationModule,
    WalletHttpModule,
  ],
})
export class ApiModule {}
