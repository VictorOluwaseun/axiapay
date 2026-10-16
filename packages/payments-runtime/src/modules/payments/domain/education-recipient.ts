import { PaymentError } from './payment.js';
import type { EducationPaymentType } from '../../service-catalog/domain/service-product.js';

/** Verified student/candidate beneficiary, scoped to its owner and immutable institution/product/purpose. */
export interface EducationRecipientValidation {
  readonly id: string;
  readonly ownerId: string;
  readonly productId: string;
  readonly institutionCode: string;
  readonly paymentType: EducationPaymentType;
  readonly purpose: string;
  readonly beneficiaryIdentifier: string;
  readonly beneficiaryName: string;
  readonly evidenceReference: string;
  readonly verifiedAt: Date;
  readonly expiresAt: Date;
}

/** Require fresh authoritative beneficiary evidence before reviewing or authorizing new terms. */
export function assertEducationRecipientCurrent(
  validation: EducationRecipientValidation,
  now: Date,
): void {
  if (validation.expiresAt.getTime() <= now.getTime()) {
    throw new PaymentError('EDUCATION_VALIDATION_EXPIRED');
  }
}
