/** Verify the standalone module composes real payment workflows without an HTTP or authentication application. */
import 'reflect-metadata';
import { NestFactory, ModulesContainer } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { PaymentRecoveryService } from '@axiapay/backend/modules/payments/services/payment-recovery.service';
import { WorkerModule } from './worker.module.js';
import { PaymentRecoveryWorker } from './jobs/payment-recovery.worker.js';

describe('worker composition', () => {
  it('boots as a headless application with no API controllers or authentication providers', async () => {
    const application = await NestFactory.createApplicationContext(
      WorkerModule,
      { logger: false, abortOnError: false },
    );
    try {
      const modules = [...application.get(ModulesContainer).values()];
      expect(modules.every((module) => module.controllers.size === 0)).toBe(
        true,
      );
      expect(modules.map((module) => module.metatype.name)).not.toContain(
        'AuthenticationModule',
      );
      expect(modules.map((module) => module.metatype.name)).not.toContain(
        'ApiModule',
      );
      expect(application.get(PaymentRecoveryWorker)).toBeInstanceOf(
        PaymentRecoveryWorker,
      );
      expect(application.get(PaymentRecoveryService)).toBeInstanceOf(
        PaymentRecoveryService,
      );
    } finally {
      await application.close();
    }
  });
});
