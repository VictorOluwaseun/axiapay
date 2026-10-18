import type {
  PaymentOutcome,
  PaymentQuote,
  PaymentSettlementAccounts,
  ServicePayment,
} from '../../domain/payment.js';
import type { ServiceProduct } from '../../../service-catalog/domain/service-product.js';
import type { BillAccountValidation } from '../../domain/bill-account.js';
import type { PaymentFulfilment } from '../../domain/payment-fulfilment.js';
import type { EducationRecipientValidation } from '../../domain/education-recipient.js';
import type { InsuranceApplication } from '../../domain/insurance-application.js';
import type { PaymentDocument } from '../../domain/payment-document.js';

import type { BankBeneficiaryValidation } from '../../domain/bank-beneficiary.js';
import type { Bank } from '../../../service-catalog/domain/bank.js';

/** First-party payment storage; all financial reads bypass cache. Durable instructions, quotes, and final evidence are immutable. */
export interface PaymentRepository {
  /** Persist an owner/product/bank-bound independently verified beneficiary snapshot without moving funds. */
  createBankBeneficiaryValidation(
    validation: BankBeneficiaryValidation,
  ): Promise<BankBeneficiaryValidation>;
  /** Read the owner's immutable bank/name-enquiry evidence, preserving history after bank withdrawal. */
  getBankBeneficiaryValidation(
    ownerId: string,
    validationId: string,
  ): Promise<BankBeneficiaryValidation | null>;
  /** Append final bank credit evidence and outcome in one transaction; partial success without recipient credit proof must roll back. */
  recordBankTransferSuccess(
    paymentId: string,
    outcome: PaymentOutcome,
    confirmation: Extract<
      PaymentFulfilment,
      { fulfilmentType: 'bank_transfer' }
    >,
  ): Promise<void>;
  /** Persist immutable authenticated student/candidate evidence without spending money. */
  createEducationValidation(
    validation: EducationRecipientValidation,
  ): Promise<EducationRecipientValidation>;
  /** Read only the owner's immutable beneficiary evidence; application code checks product binding and expiry. */
  getEducationValidation(
    ownerId: string,
    validationId: string,
  ): Promise<EducationRecipientValidation | null>;
  /** Persist consented, eligible insurance details; this is not a payment or an issued policy. */
  createInsuranceApplication(
    application: InsuranceApplication,
  ): Promise<InsuranceApplication>;
  /** Read the owner's accepted application terms without exposing persistence models or provider bodies. */
  getInsuranceApplication(
    ownerId: string,
    applicationId: string,
  ): Promise<InsuranceApplication | null>;
  /** Persist authenticated recipient evidence immutably; no validation or quote reserves wallet funds. */
  createAccountValidation(
    validation: BillAccountValidation,
  ): Promise<BillAccountValidation>;
  /** Return an owner-scoped bill recipient snapshot, including expiry; application services decide quote eligibility. */
  getAccountValidation(
    ownerId: string,
    validationId: string,
  ): Promise<BillAccountValidation | null>;
  /** Persist review terms atomically; this never reserves or spends wallet funds. */
  createQuote(quote: PaymentQuote): Promise<PaymentQuote>;
  /** Return only the requested owner's immutable quote. */
  getQuote(ownerId: string, quoteId: string): Promise<PaymentQuote | null>;
  /** Return the owner's request-key binding, including committed reservation and outcome progress. */
  findByRequestKey(
    ownerId: string,
    requestKey: string,
  ): Promise<ServicePayment | null>;
  /** Read durable payment progress; callers enforce ownership before exposing or acting on it. */
  getPayment(paymentId: string): Promise<ServicePayment | null>;
  /** Serialize quote acceptance, invoke application validation on locked terms/product, and bind one payment per quote, owner/key and insurance application.
   * Replays bypass expiry validation only when an identical binding already exists. Callback receives the locked product and optional bank profile mapped to domain contracts and performs no network or ledger work.
   */
  acceptQuote(
    input: {
      readonly id: string;
      readonly ownerId: string;
      readonly quoteId: string;
      readonly requestKey: string;
    },
    validate: (
      quote: PaymentQuote,
      product: ServiceProduct,
      bank: Bank | null,
    ) => PaymentSettlementAccounts | Promise<PaymentSettlementAccounts>,
  ): Promise<ServicePayment>;
  /** Claim the submission boundary only once after a matching reservation has committed; never reset the claim on uncertainty. */
  claimSubmission(paymentId: string): Promise<boolean>;
  /** Append correlated safe final evidence. Duplicate provider movements cannot resolve another instruction; conflicting finals fail. */
  recordOutcome(paymentId: string, outcome: PaymentOutcome): Promise<void>;
  /** Append final matching service proof, policy issuance or bill receipt/token details without modifying financial evidence or buying again. Conflicting details must fail. */
  recordFulfilment(
    paymentId: string,
    fulfilment: PaymentFulfilment,
  ): Promise<void>;
  /** Append private document descriptors atomically; duplicate matching records replay and conflicts never overwrite evidence. */
  recordDocuments(
    paymentId: string,
    documents: readonly PaymentDocument[],
  ): Promise<void>;
}
