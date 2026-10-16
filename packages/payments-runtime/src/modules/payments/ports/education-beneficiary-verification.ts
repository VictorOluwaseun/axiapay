import type { ServiceProduct } from '../../service-catalog/domain/service-product.js';

/** Independently authenticated institution/candidate observation; unresolved lookups are never treated as a verified beneficiary. */
export type EducationBeneficiaryResult = {
  readonly productId: string;
  readonly institutionCode: string;
  readonly beneficiaryIdentifier: string;
} & (
  | { readonly verificationStatus: 'invalid' | 'pending' }
  | {
      readonly verificationStatus: 'verified';
      readonly beneficiaryName: string;
      readonly evidenceReference: string;
    }
);

/** Non-purchasing education capability; implementation owns external protocol translation and evidence authenticity, not payment rules. */
export interface EducationBeneficiaryVerification {
  /** Validate the selected institution/product and exact student/candidate identifier with bounded timeout and redacted diagnostics. */
  verify(input: {
    readonly product: ServiceProduct;
    readonly beneficiaryIdentifier: string;
  }): Promise<EducationBeneficiaryResult>;
}
