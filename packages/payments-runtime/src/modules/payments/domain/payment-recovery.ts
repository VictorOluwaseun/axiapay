/** Bound automatic recovery runs before operator investigation; every process uses the same budget. */
export const maximumAutomaticRecoveryAttempts = 8;

/** A fenced claim to inspect an existing authorized payment. Attempts count recovery runs, not proven provider submissions. */
export interface PaymentRecoveryClaim {
  readonly paymentId: string;
  readonly ownerId: string;
  readonly leaseToken: string;
  readonly automaticAttempts: number;
}

/** Durable progress independent of BullMQ retention; needs_review never establishes a failed payment or permission to release funds. */
export interface PaymentRecoveryProgress {
  readonly status: 'pending' | 'completed' | 'needs_review';
  readonly automaticAttempts: number;
  readonly totalAttempts: number;
  readonly nextAttemptAt: Date;
  readonly lastFailureCode: string | null;
}
