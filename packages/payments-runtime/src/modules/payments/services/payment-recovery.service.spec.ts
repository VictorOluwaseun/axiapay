/** Verify bounded recovery, conservative uncertainty, safe diagnostics and isolation of a failed persistence attempt. */
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaymentRecoveryService } from './payment-recovery.service.js';
import { WalletPaymentService } from './wallet-payment.service.js';
import { PaymentError } from '../domain/payment.js';
import type { PaymentRecoveryRepository } from '../repositories/contracts/payment-recovery.repository.js';
import { airtimeInstruction } from '../../../../tests/support/airtime-processor-fixture.js';

/** Replace storage and provider-facing orchestration only; the actual retry and escalation workflow remains under test. */
function recoveryFixture(automaticAttempts = 1) {
  const payment = airtimeInstruction();
  const claim = {
    paymentId: payment.id,
    ownerId: payment.ownerId,
    leaseToken: 'c71269ab-cb92-47e5-b8c1-186007d1384d',
    automaticAttempts,
  };
  const repository = {
    claimDue: vi
      .fn<PaymentRecoveryRepository['claimDue']>()
      .mockResolvedValue([claim]),
    finishAttempt: vi
      .fn<PaymentRecoveryRepository['finishAttempt']>()
      .mockResolvedValue(true),
    getProgress: vi
      .fn<PaymentRecoveryRepository['getProgress']>()
      .mockResolvedValue({
        status: 'needs_review',
        automaticAttempts: 8,
        totalAttempts: 8,
        nextAttemptAt: new Date('2030-01-01T00:00:00Z'),
        lastFailureCode: 'PROVIDER_UNCONFIRMED',
      }),
    retryReview: vi.fn<PaymentRecoveryRepository['retryReview']>(),
  };
  const payments = {
    reconcile: vi
      .fn<WalletPaymentService['reconcile']>()
      .mockResolvedValue(payment),
  };
  const service = new PaymentRecoveryService(
    repository,
    payments as unknown as WalletPaymentService,
  );
  return { payment, claim, repository, payments, service };
}

afterEach(() => vi.restoreAllMocks());

describe('payment recovery', () => {
  it('uses the stored owner/payment and records bounded backoff for an unconfirmed result', async () => {
    const { service, claim, repository, payments } = recoveryFixture();
    await service.recoverDueBatch(4);
    expect(repository.claimDue).toHaveBeenCalledExactlyOnceWith(4);
    expect(payments.reconcile).toHaveBeenCalledExactlyOnceWith(
      claim.ownerId,
      claim.paymentId,
    );
    expect(repository.finishAttempt).toHaveBeenCalledExactlyOnceWith(claim, {
      status: 'pending',
      retryDelaySeconds: 30,
      failureCode: 'PROVIDER_UNCONFIRMED',
    });
  });

  it('marks settled financial evidence completed without further automatic work', async () => {
    const { service, payment, claim, repository, payments } = recoveryFixture();
    payments.reconcile.mockResolvedValue({
      ...payment,
      reservationStatus: 'captured',
      outcome: {
        outcome: 'succeeded',
        providerTransactionReference: 'original-provider-id',
        evidenceReference: 'verified-original-result',
      },
    });
    await service.recoverDueBatch(4);
    expect(repository.finishAttempt).toHaveBeenCalledExactlyOnceWith(
      claim,
      expect.objectContaining({ status: 'completed', failureCode: null }),
    );
  });

  it('escalates after eight checks while keeping uncertainty explicit', async () => {
    const { service, repository } = recoveryFixture(8);
    const log = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    await service.recoverDueBatch(4);
    expect(repository.finishAttempt).toHaveBeenCalledWith(expect.anything(), {
      status: 'needs_review',
      retryDelaySeconds: 3600,
      failureCode: 'PROVIDER_UNCONFIRMED',
    });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'payment_recovery_needs_review' }),
    );
  });

  it('retains safe timeout classification and never persists raw transport data', async () => {
    const { service, repository, payments } = recoveryFixture();
    payments.reconcile.mockRejectedValue(
      new PaymentError('PAYMENT_UNAVAILABLE', {
        reason: 'PROVIDER_TIMEOUT',
        cause: new Error('private-key recipient provider-body'),
      }),
    );
    await service.recoverDueBatch(4);
    expect(repository.finishAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: 'pending',
        failureCode: 'PROVIDER_TIMEOUT',
      }),
    );
    expect(JSON.stringify(repository.finishAttempt.mock.calls)).not.toMatch(
      /private-key|recipient provider-body/,
    );
  });

  it('does not report an escalation when a newer lease already replaced the claim', async () => {
    const { service, repository } = recoveryFixture(8);
    repository.finishAttempt.mockResolvedValue(false);
    const log = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    await service.recoverDueBatch(4);
    expect(log).not.toHaveBeenCalled();
  });

  it('finishes other claimed payments when one persistence result fails, then fails the batch for queue backoff', async () => {
    const { service, claim, repository, payments } = recoveryFixture();
    repository.claimDue.mockResolvedValue([
      claim,
      { ...claim, paymentId: '4cb51f27-91af-42d0-878c-99c5944919bc' },
    ]);
    repository.finishAttempt.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    await expect(service.recoverDueBatch(2)).rejects.toMatchObject({
      code: 'PAYMENT_UNAVAILABLE',
      cause: expect.objectContaining({ message: 'database unavailable' }),
    });
    expect(payments.reconcile).toHaveBeenCalledTimes(2);
    expect(repository.finishAttempt).toHaveBeenCalledTimes(2);
  });

  it('does not reset an active task budget through the operator retry operation', async () => {
    const { service, claim, repository } = recoveryFixture();
    repository.getProgress.mockResolvedValue({
      status: 'pending',
      automaticAttempts: 4,
      totalAttempts: 4,
      nextAttemptAt: new Date(),
      lastFailureCode: 'PROVIDER_UNCONFIRMED',
    });
    expect(await service.retryReview(claim.paymentId)).toBe(false);
    expect(repository.retryReview).not.toHaveBeenCalled();
  });

  it('audits an operator retry only when an escalated task was reopened', async () => {
    const { service, claim, repository } = recoveryFixture();
    const log = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    repository.retryReview
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    expect(await service.retryReview(claim.paymentId)).toBe(true);
    expect(await service.retryReview(claim.paymentId)).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
  });
});
