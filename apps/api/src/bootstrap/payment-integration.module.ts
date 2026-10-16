import { Module } from '@nestjs/common';
import { PaymentsModule } from '../modules/payments/payments.module.js';
import {
  VTPASS_AIRTIME,
  VtpassAirtimeModule,
} from '@axiapay/payments-runtime/modules/payments/adapters/vtpass-airtime.module';

/** Connect optional provider composition to first-party payment APIs; absent configuration leaves submission disabled and introduces no demo data. */
@Module({
  imports: [
    PaymentsModule.register({
      imports: [VtpassAirtimeModule],
      fulfilment: { useExisting: VTPASS_AIRTIME.registrations },
    }),
  ],
})
export class PaymentIntegrationModule {}
