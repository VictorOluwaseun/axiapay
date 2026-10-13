import { Inject, Injectable } from '@nestjs/common';
import { PaymentError, paymentStatus } from '../domain/payment.js';
import { assertPaymentDocumentId } from '../domain/payment-document.js';
import type { PaymentProviders } from '../ports/service-payment-provider.js';
import { PAYMENTS } from '../payments.tokens.js';
import { PaymentExecutionService } from './payment-execution.service.js';

/** Retrieve bounded PDF bytes for an owned, financially completed payment; private upstream references never become redirects or customer input. */
@Injectable()
export class PaymentDocumentService {
  /** Inject owner authorization and an optional authenticated document capability; no concrete HTTP client is accepted. */
  constructor(
    @Inject(PaymentExecutionService)
    private readonly execution: PaymentExecutionService,
    @Inject(PAYMENTS.providers) private readonly providers: PaymentProviders,
  ) {}

  /** Authorize before external I/O and enforce exact payment/document correlation, PDF media and a ten-MiB limit. */
  async retrieve(
    actorId: string,
    paymentId: string,
    documentId: string,
  ): Promise<Uint8Array> {
    assertPaymentDocumentId(documentId);
    const payment = await this.execution.get(actorId, paymentId);
    const document = payment.documents.find(
      (candidate) => candidate.documentId === documentId,
    );
    if (!document || paymentStatus(payment) !== 'succeeded') {
      throw new PaymentError('DOCUMENT_NOT_FOUND');
    }
    const registration = Object.hasOwn(
      this.providers,
      payment.quote.providerKey,
    )
      ? this.providers[payment.quote.providerKey]
      : undefined;
    if (
      !registration?.documentRetrieval ||
      registration.partnerAccountId !== payment.partnerAccountId ||
      registration.feeAccountId !== payment.feeAccountId
    ) {
      throw new PaymentError('DOCUMENT_UNAVAILABLE');
    }
    try {
      const result = await registration.documentRetrieval.retrieve({
        payment,
        document,
      });
      if (
        result.paymentId !== payment.id ||
        result.documentId !== document.documentId ||
        result.providerDocumentReference !==
          document.providerDocumentReference ||
        result.contentType !== 'application/pdf' ||
        !(result.bytes instanceof Uint8Array) ||
        result.bytes.byteLength < 5 ||
        result.bytes.byteLength > 10 * 1024 * 1024 ||
        String.fromCharCode(...result.bytes.subarray(0, 5)) !== '%PDF-'
      ) {
        throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
      }
      return result.bytes;
    } catch (error) {
      throw new PaymentError('DOCUMENT_UNAVAILABLE', { cause: error });
    }
  }
}
