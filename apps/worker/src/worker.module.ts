import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import {
  VTPASS_AIRTIME,
  VtpassAirtimeModule,
} from '@axiapay/backend/modules/payments/adapters/vtpass-airtime.module';
import { PaymentsRuntimeModule } from '@axiapay/backend/modules/payments/payments-runtime.module';
import { validateWorkerEnvironment } from './config/environment.js';
import { PaymentRecoveryWorker } from './jobs/payment-recovery.worker.js';

/** Compose a headless BullMQ process with shared payment rules; no API module, HTTP controllers or authentication secrets are required. */
@Module({
  imports: [
    ConfigModule.forRoot({
      validate: validateWorkerEnvironment,
      ignoreEnvFile: process.env.NODE_ENV === 'test',
    }),
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      /** Keep worker diagnostics structured and independent of HTTP access logging. */
      useFactory: (configuration: ConfigService) => ({
        pinoHttp: {
          level: configuration.getOrThrow<string>('LOG_LEVEL'),
          autoLogging: false,
        },
      }),
    }),
    PaymentsRuntimeModule.register({
      imports: [VtpassAirtimeModule],
      fulfilment: { useExisting: VTPASS_AIRTIME.registrations },
    }),
  ],
  providers: [PaymentRecoveryWorker],
})
export class WorkerModule {}
