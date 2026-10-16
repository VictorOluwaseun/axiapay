import { Inject, Injectable, Logger } from '@nestjs/common';
import { PaymentError, paymentStatus } from '../domain/payment.js';
import { needsPaymentFulfilment } from '../domain/payment-fulfilment.js';
import {
  maximumAutomaticRecoveryAttempts,
  type PaymentRecoveryClaim,
} from '../domain/payment-recovery.js';
import type { PaymentRecoveryRepository } from '../repositories/contracts/payment-recovery.repository.js';
import { PAYMENTS } from '../payments.tokens.js';
import { WalletPaymentService } from './wallet-payment.service.js';
import { WalletError } from '../../wallets/domain/wallet-error.js';

/** Follow existing authorized payments through their normal recovery/settlement service. Bounded automatic checks escalate uncertainty without releasing funds or resetting the purchase claim. */
@Injectable()
export class PaymentRecoveryService {
  private readonly logger = new Logger(PaymentRecoveryService.name);

  /** Keep storage private and reuse the same payment workflow as HTTP callers; queue scheduling owns no payment policy. */
  constructor(
    @Inject(PAYMENTS.recoveryRepository)
    private readonly recovery: PaymentRecoveryRepository,
    @Inject(WalletPaymentService)
    private readonly payments: WalletPaymentService,
  ) {}

  /** Process at most concurrency due leases, isolating failed persistence so other claimed payments finish; an expired lease recovers an interrupted run. */
  async recoverDueBatch(concurrency: number): Promise<void> {
    const claims = await this.recovery.claimDue(concurrency);
    const results = await Promise.allSettled(
      claims.map((claim) => this.recover(claim)),
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) {
      throw new PaymentError('PAYMENT_UNAVAILABLE', { cause: failed.reason });
    }
  }

  /** Resume automatic status checks after operator investigation, without new consent, a new merchant reference, another purchase or any manual wallet release. Returns false unless a task is awaiting review. */
  async retryReview(paymentId: string): Promise<boolean> {
    const progress = await this.recovery.getProgress(paymentId);
    if (progress?.status !== 'needs_review') {
      return false;
    }
    const reopened = await this.recovery.retryReview(paymentId);
    if (reopened) {
      this.logger.warn({
        event: 'payment_recovery_review_reopened',
        paymentId,
        previousTotalAttempts: progress.totalAttempts,
      });
    }
    return reopened;
  }

  /** Complete each fenced claim from verified financial progress; missing/unknown evidence and dependency failures receive backoff, then durable manual-review escalation after eight checks. */
  private async recover(claim: PaymentRecoveryClaim): Promise<void> {
    let completed = false;
    let failureCode = 'PROVIDER_UNCONFIRMED';
    try {
      const payment = await this.payments.reconcile(
        claim.ownerId,
        claim.paymentId,
      );
      completed =
        ['succeeded', 'failed'].includes(paymentStatus(payment)) &&
        !needsPaymentFulfilment(payment);
    } catch (error) {
      failureCode = 'RECOVERY_UNAVAILABLE';
      if (error instanceof PaymentError) {
        failureCode = error.reason ?? error.code;
      }
      if (error instanceof WalletError) {
        failureCode = error.code;
      }
    }
    let status: 'pending' | 'completed' | 'needs_review' = completed
      ? 'completed'
      : 'pending';
    if (
      !completed &&
      claim.automaticAttempts >= maximumAutomaticRecoveryAttempts
    ) {
      status = 'needs_review';
    }
    const saved = await this.recovery.finishAttempt(claim, {
      status,
      retryDelaySeconds: Math.min(
        3600,
        30 * 2 ** Math.min(claim.automaticAttempts - 1, 7),
      ),
      failureCode: completed ? null : failureCode,
    });
    if (saved && status === 'needs_review') {
      this.logger.error({
        event: 'payment_recovery_needs_review',
        paymentId: claim.paymentId,
        failureCode,
      });
    }
  }
}
