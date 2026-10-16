import type { ServiceProduct } from '../../service-catalog/domain/service-product.js';

/** First-party insured facts selected from a provider's current supported values; no upstream option codes enter public contracts. */
export type InsuranceOptionField =
  | 'engineCapacityBand'
  | 'vehicleMake'
  | 'vehicleModel'
  | 'vehicleColour'
  | 'state'
  | 'localGovernmentArea';

/** A meaningful insured fact persisted in the application; provider-specific codes remain adapter translations. */
export interface InsuranceInputOption {
  readonly value: string;
  readonly label: string;
}

/** Non-purchasing choice discovery, independently replaceable with any insurer/provider adapter. */
export interface InsuranceInputOptions {
  /** List current product-specific options. Vehicle models depend on the selected make; local areas depend on the selected state. */
  list(input: {
    readonly product: ServiceProduct;
    readonly field: InsuranceOptionField;
    readonly parentValue?: string;
  }): Promise<readonly InsuranceInputOption[]>;
}
