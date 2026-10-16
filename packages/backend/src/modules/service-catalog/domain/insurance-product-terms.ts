/** Explicit individual underwriting inputs supported by first-party contracts; products collect only their configured fields. */
export type InsuredField =
  | 'fullName'
  | 'dateOfBirth'
  | 'phoneNumber'
  | 'email'
  | 'address'
  | 'identityNumber'
  | 'assetReference';

/** Immutable reviewable terms for a fixed-premium individual product; no provider defaults or coverage guarantees are inferred. */
export interface InsuranceProductTerms {
  readonly version: string;
  readonly coverageSummary: string;
  readonly exclusions: readonly string[];
  readonly coverageDurationDays: number;
  readonly cancellationRefundTerms: string;
  readonly requiredInsuredFields: readonly InsuredField[];
  readonly optionalInsuredFields: readonly InsuredField[];
}
