import type { BankBeneficiaryVerification } from './bank-beneficiary-verification.js';
import type { BankTransferFailureReason } from '../domain/bank-beneficiary.js';
import type { ServicePayment } from '../domain/payment.js';
import type { PaymentFulfilment } from '../domain/payment-fulfilment.js';
import type { BillAccountVerification } from './bill-account-verification.js';
import type { EducationBeneficiaryVerification } from './education-beneficiary-verification.js';
import type { InsuranceEligibility } from './insurance-eligibility.js';
import type { PaymentDocumentRetrieval } from './payment-document-retrieval.js';
import type { PaymentDocument } from '../domain/payment-document.js';

/** First-party evidence contract. Adapters authenticate upstream results and verify recipient, product, amount and logical identity before returning it. */
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

/** External fulfilment capability; adapters translate instructions without owning payment/wallet rules and enforce bounded network timeouts with redacted diagnostics. */
export interface ServicePaymentProvider {
  /** Submit once using payment.id as the stable merchant identity. Never retry an uncertain upstream submission blindly. */
  submit(payment: ServicePayment): Promise<ProviderPaymentResult>;
  /** Query independently authenticated evidence for that same identity; no new purchase may be sent by this method. */
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
