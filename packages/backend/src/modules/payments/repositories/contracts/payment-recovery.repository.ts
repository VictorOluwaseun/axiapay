import type {
  PaymentRecoveryClaim,
  PaymentRecoveryProgress,
} from '../../domain/payment-recovery.js';

/** Authoritative recovery storage. Holds create intent atomically; workers borrow expiring leases and update only their own claim. No cache, queue types or financial mutation enters this contract. */
export interface PaymentRecoveryRepository {
  /** Claim a bounded due batch across workers, recovering expired leases and incrementing durable recovery-attempt counters. */
  claimDue(limit: number): Promise<readonly PaymentRecoveryClaim[]>;
  /** Persist the result only while this lease still owns the task; stale completions cannot overwrite a newer claim or operator retry. */
  finishAttempt(
    claim: PaymentRecoveryClaim,
    result: {
      readonly status: PaymentRecoveryProgress['status'];
      readonly retryDelaySeconds: number;
      readonly failureCode: string | null;
    },
  ): Promise<boolean>;
  /** Read internal progress without implying a financial outcome; customer ownership must be checked separately before exposure. */
  getProgress(paymentId: string): Promise<PaymentRecoveryProgress | null>;
  /** Reopen an escalated task for a trusted operator, keeping lifetime attempts, the original payment identity, wallet hold and submission claim. */
  retryReview(paymentId: string): Promise<boolean>;
}
