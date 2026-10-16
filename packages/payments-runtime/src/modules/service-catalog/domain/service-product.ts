import type { InsuranceProductTerms } from './insurance-product-terms.js';

/** First-party purchase categories; provider names and identifiers remain infrastructure details. */
export type ServiceType =
  | 'airtime'
  | 'data'
  | 'tv'
  | 'electricity'
  | 'education'
  | 'insurance'
  | 'bank_transfer'
  | 'merchant';

/** Education products identify the financial purpose and whether a voucher or institution reference is delivered. */
export type EducationPaymentType = 'institution_fee' | 'voucher';

/** Meter/account billing mode is an immutable product property, never an unverified customer override. */
export type ElectricityMeterType = 'prepaid' | 'postpaid';

/** Immutable catalogue revision with operator-controlled eligibility, exact pricing, and customer-facing plan information. */
export interface ServiceProduct {
  readonly id: string;
  readonly serviceType: ServiceType;
  readonly networkCode: string | null;
  readonly billerCode: string | null;
  readonly electricityMeterType: ElectricityMeterType | null;
  readonly bankId: string | null;
  readonly bankBeneficiaryValidationLifetimeSeconds: number | null;
  readonly accountValidationLifetimeSeconds: number | null;
  readonly educationPaymentType: EducationPaymentType | null;
  readonly educationPurpose: string | null;
  /** False only for delivery-phone vouchers that have no candidate verification protocol; legacy products default to true. */
  readonly educationRecipientVerificationRequired?: boolean;
  readonly educationValidationLifetimeSeconds: number | null;
  readonly insuranceTerms: InsuranceProductTerms | null;
  readonly insuranceApplicationLifetimeSeconds: number | null;
  readonly displayName: string;
  readonly currency: string;
  readonly fixedPriceMinorUnits: bigint | null;
  readonly minimumAmountMinorUnits: bigint;
  readonly maximumAmountMinorUnits: bigint;
  readonly amountStepMinorUnits: bigint;
  readonly feeMinorUnits: bigint;
  readonly allowanceLabel: string | null;
  readonly validitySeconds: number | null;
  readonly quoteLifetimeSeconds: number;
  readonly providerKey: string;
  readonly providerProductCode: string;
  readonly isEnabled: boolean;
}

/** Bounded, deterministic catalogue query; cursor identifies the last product revision returned. */
export interface ProductQuery {
  readonly serviceType?: ServiceType;
  readonly networkCode?: string;
  readonly billerCode?: string;
  readonly electricityMeterType?: ElectricityMeterType;
  readonly bankId?: string;
  readonly currency?: string;
  readonly afterId?: string;
  readonly limit: number;
}

/** A page of enabled revisions; a null cursor indicates that no further revisions were found. */
export interface ProductPage {
  readonly products: readonly ServiceProduct[];
  readonly nextCursor: string | null;
}
