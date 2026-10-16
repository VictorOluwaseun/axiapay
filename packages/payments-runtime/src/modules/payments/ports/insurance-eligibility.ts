import type { ServiceProduct } from '../../service-catalog/domain/service-product.js';
import type { InsuredProfile } from '../domain/insurance-application.js';

/** Correlated eligibility evidence is independent of premium payment and actual policy issuance. */
export type InsuranceEligibilityResult = {
  readonly applicationFingerprint: string;
} & (
  | { readonly eligibilityStatus: 'ineligible' | 'pending' }
  | {
      readonly eligibilityStatus: 'eligible';
      readonly evidenceReference: string;
    }
);

/** Non-purchasing eligibility/underwriting capability for supported fixed-premium products; adapters cannot silently reprice accepted terms. */
export interface InsuranceEligibility {
  /** Verify submitted insured details and requested period under the selected reviewed terms; no payment or policy purchase may be sent. */
  verify(input: {
    readonly product: ServiceProduct;
    readonly insuredProfile: InsuredProfile;
    readonly termsVersion: string;
    readonly coverageStartsOn: string;
    readonly coverageEndsOn: string;
    readonly applicationFingerprint: string;
  }): Promise<InsuranceEligibilityResult>;
}
