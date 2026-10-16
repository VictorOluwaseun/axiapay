/** Trusted-host operation: reopen bounded recovery after investigation. It cannot mark a payment failed, refund funds or generate another purchase identity. */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { withValidatedInput } from '@axiapay/backend/shared/validation/input-validation';
import { RetryPaymentRecoveryDto } from './jobs/payment-recovery-job.dto.js';
import { PaymentRecoveryService } from '@axiapay/backend/modules/payments/services/payment-recovery.service';

/** Validate the CLI before creating clients, disable the background consumer for this one operation and always close the module graph. */
async function retryPaymentRecovery(): Promise<void> {
  if (process.argv.length !== 3) {
    throw new Error('Usage: payments:retry-recovery <payment-uuid>');
  }
  await withValidatedInput(
    RetryPaymentRecoveryDto,
    { paymentId: process.argv[2] },
    async ({ paymentId }) => {
      process.env.PAYMENT_RECOVERY_ENABLED = 'false';
      const { WorkerModule } = await import('./worker.module.js');
      const application = await NestFactory.createApplicationContext(
        WorkerModule,
        { logger: false },
      );
      try {
        const reopened = await application
          .get(PaymentRecoveryService)
          .retryReview(paymentId);
        console.log(JSON.stringify({ paymentId, reopened }));
      } finally {
        await application.close();
      }
    },
  );
}

await retryPaymentRecovery();
