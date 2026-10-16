import type { BankBeneficiaryVerification } from './bank-beneficiary-verification.js';
import type { BankTransferFailureReason } from '../domain/bank-beneficiary.js';
import type { PaymentQuote, ServicePayment } from '../domain/payment.js';
import type { ServiceProduct } from '../../service-catalog/domain/service-product.js';
import type { PaymentFulfilment } from '../domain/payment-fulfilment.js';
import type { BillAccountVerification } from './bill-account-verification.js';
import type { EducationBeneficiaryVerification } from './education-beneficiary-verification.js';
import type { InsuranceEligibility } from './insurance-eligibility.js';
import type { PaymentDocumentRetrieval } from './payment-document-retrieval.js';
import type { PaymentDocument } from '../domain/payment-document.js';

/** First-party evidence contract. Adapters authenticate upstream results and correlate provider references, recipient, product and amount. The execution workflow owns checking the returned payment ID and terms fingerprint against the accepted payment. */
export type ProviderPaymentResult = {
  readonly paymentId: string;
  readonly termsFingerprint: string;
} & (
  | { readonly outcome: 'pending' }
  | {
      readonly outcome: 'succeeded';
      readonly providerTransactionReference: string;
      readonly evidenceReference: string;
      /** Service receipts may follow financial confirmation. Bank transfers instead require complete authenticated recipient-credit proof before success, matching all quoted recipient/principal fields. */
      readonly fulfilment?: PaymentFulfilment;
      /** Document metadata may arrive after financial confirmation and policy issuance; descriptors are stored independently and immutably. */
      readonly documents?: readonly PaymentDocument[];
    }
  | {
      readonly outcome: 'failed';
      readonly providerTransactionReference: string;
      readonly evidenceReference: string;
      readonly fundsSafeToRelease: boolean;
      /** Optional safe classification for a confirmed bank failure; omitted reasons use transfer_not_completed. Never map a timeout to final failure. */
      readonly bankTransferFailureReason?: BankTransferFailureReason;
    }
);

/** Trusted catalogue product or complete review quote. Product validation checks routing/encoding support; quote validation additionally checks recipient representability. */
export type PaymentTermsInput =
  | { readonly scope: 'product'; readonly terms: ServiceProduct }
  | { readonly scope: 'quote'; readonly terms: PaymentQuote };

/** External fulfilment capability; adapters translate instructions without owning payment/wallet rules and enforce bounded network timeouts with redacted diagnostics. */
export interface ServicePaymentProvider {
  /** Optional pure protocol validation for a product or quote; throws a PaymentError before any new hold and performs no I/O or financial authorization. */
  validate?(target: PaymentTermsInput): void;
  /** Submit once using payment.id as the stable merchant identity. Never retry an uncertain upstream submission blindly. */
  submit(payment: ServicePayment): Promise<ProviderPaymentResult>;
  /** Query independently authenticated evidence for the saved identity and accepted terms, without current purchase-eligibility validation or another purchase. Retain historical evidence support for unresolved obligations. */
  lookup(payment: ServicePayment): Promise<ProviderPaymentResult>;
}

/** Explicit adapter registration includes administratively provisioned retail clearing/fee accounts; no SDK or credential enters workflow code. */
export interface PaymentProviderRegistration {
  readonly adapter: ServicePaymentProvider;
  readonly bankBeneficiaryVerification?: BankBeneficiaryVerification;
  readonly accountVerification?: BillAccountVerification;
  readonly educationVerification?: EducationBeneficiaryVerification;
  readonly insuranceEligibility?: InsuranceEligibility;
  readonly documentRetrieval?: PaymentDocumentRetrieval;
  readonly partnerAccountId: string;
  readonly feeAccountId: string | null;
}

/** Immutable deployment routing keys isolate provider accounts/environments; absent registrations disable submission before funds are held. */
export type PaymentProviders = Readonly<
  Record<string, PaymentProviderRegistration | undefined>
>;

/** Inject UTC time so expiry and recovery can be verified without sleeping or changing system time. */
export interface PaymentClock {
  /** Return the current UTC instant. */
  now(): Date;
}
