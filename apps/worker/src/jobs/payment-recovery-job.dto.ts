import { Equals, IsInt, IsUUID } from 'class-validator';

/** Untrusted queue wake-up carries only a protocol version; payment identities and eligibility are read from authoritative storage. */
export class PaymentRecoverySweepDto {
  @IsInt()
  @Equals(1)
  version!: 1;
}

/** Trusted-host operator input may reopen a review task but cannot supply an outcome, wallet owner, evidence or financial amount. */
export class RetryPaymentRecoveryDto {
  @IsUUID()
  paymentId!: string;
}
