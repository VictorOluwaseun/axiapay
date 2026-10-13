import type {
  ElectricityMeterType,
  ServiceProduct,
} from '../../service-catalog/domain/service-product.js';

/** Correlated independent bill-account observation; a timeout/pending response is never a verified customer. */
export type BillAccountVerificationResult = {
  readonly productId: string;
  readonly accountNumber: string;
  readonly billerCode: string;
  readonly electricityMeterType: ElectricityMeterType | null;
} & (
  | { readonly verificationStatus: 'invalid' | 'pending' }
  | {
      readonly verificationStatus: 'verified';
      readonly customerName: string;
      readonly serviceAddress: string | null;
      readonly evidenceReference: string;
    }
);

/** Optional provider capability for customer/meter validation; adapters own protocol translation, authenticity and bounded timeouts only. */
export interface BillAccountVerification {
  /** Validate without initiating a purchase. Return the exact requested product/account/meter correlation and only authenticated customer details. */
  verify(input: {
    readonly product: ServiceProduct;
    readonly accountNumber: string;
  }): Promise<BillAccountVerificationResult>;
}
