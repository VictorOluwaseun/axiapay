import type { ServicePayment } from '../domain/payment.js';
import type { PaymentDocument } from '../domain/payment-document.js';

/** Authenticated document bytes correlated to the original payment and private descriptor; no external redirect is allowed. */
export interface RetrievedPaymentDocument {
  readonly paymentId: string;
  readonly documentId: string;
  readonly providerDocumentReference: string;
  readonly contentType: 'application/pdf';
  readonly bytes: Uint8Array;
}

/** Fetch an already-issued document with bounded timeout/size and authenticated provider access; never initiate or repeat a purchase. */
export interface PaymentDocumentRetrieval {
  /** Resolve only the stored descriptor, ignoring user-controlled URLs, filenames and upstream identifiers. */
  retrieve(input: {
    readonly payment: ServicePayment;
    readonly document: PaymentDocument;
  }): Promise<RetrievedPaymentDocument>;
}
