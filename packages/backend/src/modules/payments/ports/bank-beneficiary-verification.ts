import type { Bank } from '../../service-catalog/domain/bank.js';
import type { ServiceProduct } from '../../service-catalog/domain/service-product.js';

/** Independently authenticated name enquiry correlated to exact first-party bank/product/account/currency; pending is neither verified nor invalid. */
export type BankBeneficiaryResult = {
  readonly productId: string;
  readonly bankId: string;
  readonly accountNumber: string;
  readonly currency: string;
} & (
  | { readonly verificationStatus: 'invalid' | 'pending' }
  | {
      readonly verificationStatus: 'verified';
      readonly accountName: string;
      readonly evidenceReference: string;
    }
);

/** Non-spending beneficiary verification capability; adapters translate bank identifiers and authenticate name enquiries without initiating transfers. */
export interface BankBeneficiaryVerification {
  /** Resolve the selected numeric account with bounded timeout and redacted diagnostics; preserve identifiers and never infer a name from client input. */
  verify(input: {
    readonly bank: Bank;
    readonly product: ServiceProduct;
    readonly accountNumber: string;
  }): Promise<BankBeneficiaryResult>;
}
