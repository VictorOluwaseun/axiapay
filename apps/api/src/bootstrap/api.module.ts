import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { HealthModule } from '../modules/health/health.module.js';
import { validateEnvironment } from '../infrastructure/config/environment.js';
import { createLoggerOptions } from '../infrastructure/observability/logger-options.js';

/** Compose delivery, configuration, and diagnostics; feature workflows are added through modules. */
@Module({
  imports: [
    ConfigModule.forRoot({ validate: validateEnvironment }),
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: createLoggerOptions,
    }),
    HealthModule,
  ],
})
export class ApiModule {}
