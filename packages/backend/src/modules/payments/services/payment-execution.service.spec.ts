/** Verify that the execution workflow rejects mismatched first-party observations before persistence, retaining the original claim and unresolved hold. */
import { describe, expect, it, vi } from 'vitest';
import {
  airtimeInstruction,
  pendingAirtimeSubmission,
  testAirtimeAdapter,
} from '../../../../tests/support/airtime-processor-fixture.js';
import type { ServiceCatalogService } from '../../service-catalog/services/service-catalog.service.js';
import type { ServicePayment } from '../domain/payment.js';
import { AirtimeProcessor } from '../processors/airtime.processor.js';
import type { PaymentRepository } from '../repositories/contracts/payment.repository.js';
import { PaymentExecutionService } from './payment-execution.service.js';

/** Exercise the actual processor and execution service; replace only durable storage and the external protocol with controlled test contracts. */
function executionFixture() {
  let saved: ServicePayment = {
    ...airtimeInstruction(),
    submissionStartedAt: null,
  };
  const adapter = testAirtimeAdapter();
  const repository = {
    getPayment: vi
      .fn<PaymentRepository['getPayment']>()
      .mockImplementation(async (id) => (id === saved.id ? saved : null)),
    claimSubmission: vi
      .fn<PaymentRepository['claimSubmission']>()
      .mockImplementation(async (id) => {
        if (id !== saved.id || saved.submissionStartedAt) {
          return false;
        }
        saved = {
          ...saved,
          submissionStartedAt: new Date('2030-01-01T00:00:01Z'),
        };
        return true;
      }),
    recordOutcome: vi.fn<PaymentRepository['recordOutcome']>(),
    recordFulfilment: vi.fn<PaymentRepository['recordFulfilment']>(),
    recordDocuments: vi.fn<PaymentRepository['recordDocuments']>(),
    recordBankTransferSuccess:
      vi.fn<PaymentRepository['recordBankTransferSuccess']>(),
  };
  const execution = new PaymentExecutionService(
    repository as unknown as PaymentRepository,
    {} as ServiceCatalogService,
    {
      [adapter.providerKey]: {
        adapter: new AirtimeProcessor(adapter),
        partnerAccountId: saved.partnerAccountId,
        feeAccountId: saved.feeAccountId,
      },
    },
    { now: () => new Date('2030-01-01T00:00:01Z') },
  );
  return { execution, payment: saved, repository, adapter };
}

describe.each(['pending', 'succeeded', 'failed'] as const)(
  '%s provider observations',
  (outcome) => {
    it.each([
      ['dispatch', 'paymentId', 'PAYMENT_ID_MISMATCH'],
      ['dispatch', 'termsFingerprint', 'PAYMENT_TERMS_MISMATCH'],
      ['reconcile', 'paymentId', 'PAYMENT_ID_MISMATCH'],
      ['reconcile', 'termsFingerprint', 'PAYMENT_TERMS_MISMATCH'],
    ] as const)(
      'rejects %s results with a mismatched %s before recording evidence',
      async (operation, field, reason) => {
        const { execution, payment, repository, adapter } = executionFixture();
        let accepted = payment;
        if (operation === 'reconcile') {
          accepted = await execution.dispatch(payment);
        }
        const observation =
          outcome === 'pending'
            ? pendingAirtimeSubmission(accepted)
            : {
                ...pendingAirtimeSubmission(accepted),
                outcome,
                providerTransactionReference: 'test-provider-movement',
                evidenceReference: 'test-evidence',
                fundsSafeToRelease: true,
              };
        const mismatched = { ...observation, [field]: 'mismatched-evidence' };
        adapter.toSubmission.mockReturnValueOnce(mismatched);
        adapter.lookup.mockResolvedValueOnce(mismatched);

        await expect(execution[operation](accepted)).rejects.toMatchObject({
          code: 'PAYMENT_UNAVAILABLE',
          reason,
          cause: { code: 'INVALID_PROVIDER_EVIDENCE', reason },
        });
        expect(repository.recordOutcome).not.toHaveBeenCalled();
        expect(repository.recordFulfilment).not.toHaveBeenCalled();
        expect(repository.recordDocuments).not.toHaveBeenCalled();
        expect(repository.recordBankTransferSuccess).not.toHaveBeenCalled();
        const stored = await execution.get(payment.ownerId, payment.id);
        expect(stored.submissionStartedAt).not.toBeNull();
        expect(stored.reservationStatus).toBe('reserved');
        expect(stored.outcome).toBeNull();
        expect(repository.claimSubmission).toHaveBeenCalledExactlyOnceWith(
          payment.id,
        );
        expect(adapter.execute).toHaveBeenCalledTimes(1);
        expect(adapter.lookup).toHaveBeenCalledTimes(
          operation === 'reconcile' ? 1 : 0,
        );
      },
    );
  },
);
