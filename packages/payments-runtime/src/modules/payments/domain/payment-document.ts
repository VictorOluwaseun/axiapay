import { assertBillDisplayText } from './bill-account.js';
import { PaymentError, type ServicePayment } from './payment.js';

/** Stored authenticated document descriptor; private upstream references never enter customer-facing responses or redirects. */
export interface PaymentDocument {
  readonly documentId: string;
  readonly documentType: 'education_receipt' | 'policy' | 'certificate';
  readonly displayName: string;
  readonly contentType: 'application/pdf';
  readonly providerDocumentReference: string;
}

/** Validate a stable first-party document key independently of upstream URLs or filenames. */
export function assertPaymentDocumentId(documentId: string): void {
  if (
    typeof documentId !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{0,49}(?![\s\S])/.test(documentId)
  ) {
    throw new PaymentError('INVALID_PAYMENT');
  }
}

/** Project only service-appropriate authenticated document metadata before append-only storage. */
export function validatedPaymentDocument(
  payment: ServicePayment,
  document: PaymentDocument,
): PaymentDocument {
  if (!document || typeof document !== 'object') {
    throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
  }
  assertPaymentDocumentId(document.documentId);
  const isEducationProof =
    payment.quote.serviceType === 'education' &&
    document.documentType === 'education_receipt';
  const isIssuedPolicyProof =
    payment.quote.serviceType === 'insurance' &&
    payment.fulfilment?.fulfilmentType === 'insurance_policy' &&
    ['policy', 'certificate'].includes(document.documentType);
  if (
    (!isEducationProof && !isIssuedPolicyProof) ||
    document.contentType !== 'application/pdf'
  ) {
    throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
  }
  assertBillDisplayText(document.displayName, 200);
  assertBillDisplayText(document.providerDocumentReference, 200);
  return {
    documentId: document.documentId,
    documentType: document.documentType,
    displayName: document.displayName,
    contentType: 'application/pdf',
    providerDocumentReference: document.providerDocumentReference,
  };
}
