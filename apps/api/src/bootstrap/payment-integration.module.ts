import { Module } from '@nestjs/common';
import { PaymentsModule } from '../modules/payments/payments.module.js';
import {
  VTPASS_PAYMENTS,
  VtpassPaymentsModule,
} from '@axiapay/payments-runtime/modules/payments/adapters/vtpass-payments.module';

/** Connect optional provider composition to first-party payment APIs; absent configuration leaves submission disabled and introduces no demo data. */
@Module({
  imports: [
    PaymentsModule.register({
      imports: [VtpassPaymentsModule.register()],
      fulfilment: { useExisting: VTPASS_PAYMENTS.registrations },
    }),
  ],
})
export class PaymentIntegrationModule {}
