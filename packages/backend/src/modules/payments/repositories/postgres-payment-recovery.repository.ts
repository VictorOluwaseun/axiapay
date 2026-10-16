import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../../../infrastructure/database/create-database.js';
import {
  maximumAutomaticRecoveryAttempts,
  type PaymentRecoveryClaim,
  type PaymentRecoveryProgress,
} from '../domain/payment-recovery.js';
import type { PaymentRecoveryRepository } from './contracts/payment-recovery.repository.js';

/** Own PostgreSQL recovery scheduling, SKIP LOCKED claims and lease fencing through the shared pool. Financial records remain untouched and every read bypasses cache. */
export class PostgresPaymentRecoveryRepository implements PaymentRecoveryRepository {
  /** Borrow the lifecycle-managed SQL client; a claim is one atomic statement with no provider calls under locks. */
  constructor(private readonly database: Kysely<DatabaseSchema>) {}

  /** @inheritdoc PaymentRecoveryRepository.claimDue */
  async claimDue(limit: number): Promise<readonly PaymentRecoveryClaim[]> {
    const result = await sql<{
      payment_id: string;
      owner_id: string;
      lease_token: string;
      automatic_attempts: number;
    }>`
      with review_due as (
        select payment_id from service_payment_recovery
        where recovery_status = 'pending' and automatic_attempts >= ${maximumAutomaticRecoveryAttempts}
          and (lease_expires_at is null or lease_expires_at <= now())
        order by next_attempt_at, payment_id limit ${limit} for update skip locked
      ), exhausted as (
        update service_payment_recovery recovery set recovery_status = 'needs_review', lease_token = null,
          lease_expires_at = null, updated_at = now(), last_failure_code = 'RECOVERY_INTERRUPTED'
        from review_due where recovery.payment_id = review_due.payment_id
      ), due as (
        select payment_id from service_payment_recovery
        where recovery_status = 'pending' and automatic_attempts < ${maximumAutomaticRecoveryAttempts} and next_attempt_at <= now()
          and (lease_expires_at is null or lease_expires_at <= now())
        order by next_attempt_at, payment_id limit ${limit} for update skip locked
      ), claimed as (
        update service_payment_recovery recovery set lease_token = gen_random_uuid(),
          lease_expires_at = now() + interval '2 minutes', updated_at = now(),
          automatic_attempts = automatic_attempts + 1, total_attempts = total_attempts + 1
        from due where recovery.payment_id = due.payment_id
        returning recovery.payment_id, recovery.lease_token, recovery.automatic_attempts
      )
      select claimed.*, payment.owner_id from claimed join service_payments payment on payment.id = claimed.payment_id
    `.execute(this.database);
    return result.rows.map((row) => ({
      paymentId: row.payment_id,
      ownerId: row.owner_id,
      leaseToken: row.lease_token,
      automaticAttempts: row.automatic_attempts,
    }));
  }

  /** @inheritdoc PaymentRecoveryRepository.finishAttempt */
  async finishAttempt(
    claim: PaymentRecoveryClaim,
    result: Parameters<PaymentRecoveryRepository['finishAttempt']>[1],
  ): Promise<boolean> {
    const saved = await this.database
      .updateTable('service_payment_recovery')
      .set({
        recovery_status: result.status,
        next_attempt_at: sql<Date>`now() + ${result.retryDelaySeconds} * interval '1 second'`,
        last_failure_code: result.failureCode,
        lease_token: null,
        lease_expires_at: null,
        updated_at: sql<Date>`now()`,
      })
      .where('payment_id', '=', claim.paymentId)
      .where('lease_token', '=', claim.leaseToken)
      .where('recovery_status', '=', 'pending')
      .returning('payment_id')
      .executeTakeFirst();
    return saved !== undefined;
  }

  /** @inheritdoc PaymentRecoveryRepository.getProgress */
  async getProgress(
    paymentId: string,
  ): Promise<PaymentRecoveryProgress | null> {
    const row = await this.database
      .selectFrom('service_payment_recovery')
      .selectAll()
      .where('payment_id', '=', paymentId)
      .executeTakeFirst();
    if (!row) {
      return null;
    }
    return {
      status: row.recovery_status as PaymentRecoveryProgress['status'],
      automaticAttempts: row.automatic_attempts,
      totalAttempts: row.total_attempts,
      nextAttemptAt: row.next_attempt_at,
      lastFailureCode: row.last_failure_code,
    };
  }

  /** @inheritdoc PaymentRecoveryRepository.retryReview */
  async retryReview(paymentId: string): Promise<boolean> {
    const saved = await this.database
      .updateTable('service_payment_recovery')
      .set({
        recovery_status: 'pending',
        automatic_attempts: 0,
        next_attempt_at: sql<Date>`now()`,
        lease_token: null,
        lease_expires_at: null,
        last_failure_code: null,
        updated_at: sql<Date>`now()`,
      })
      .where('payment_id', '=', paymentId)
      .where('recovery_status', '=', 'needs_review')
      .returning('payment_id')
      .executeTakeFirst();
    return saved !== undefined;
  }
}
