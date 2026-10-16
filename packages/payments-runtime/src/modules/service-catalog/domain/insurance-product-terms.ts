/** Explicit individual underwriting inputs supported by first-party contracts; products collect only their configured fields. */
export type InsuredField =
  | 'fullName'
  | 'dateOfBirth'
  | 'phoneNumber'
  | 'email'
  | 'address'
  | 'identityNumber'
  | 'assetReference'
  | 'nextOfKinName'
  | 'nextOfKinPhoneNumber'
  | 'occupation'
  | 'engineCapacityBand'
  | 'chassisNumber'
  | 'vehicleMake'
  | 'vehicleModel'
  | 'vehicleColour'
  | 'manufactureYear'
  | 'state'
  | 'localGovernmentArea';

/** Immutable reviewable terms for a fixed-premium individual product; no provider defaults or coverage guarantees are inferred. */
export interface InsuranceProductTerms {
  readonly version: string;
  /** Provider verification is the legacy default. Submission requirements explicitly authorize local product-rule and authenticated option/price checks without claiming underwriting or coverage. */
  readonly eligibilityMode?: 'provider_verified' | 'submission_requirements';
  /** Requested periods remain the legacy default; provider-assigned starts require explicit reviewed consent and same-day application creation. */
  readonly coverageStartMode?: 'requested' | 'provider_assigned';
  readonly coverageSummary: string;
  readonly exclusions: readonly string[];
  readonly coverageDurationDays: number;
  readonly cancellationRefundTerms: string;
  readonly requiredInsuredFields: readonly InsuredField[];
  readonly optionalInsuredFields: readonly InsuredField[];
}
