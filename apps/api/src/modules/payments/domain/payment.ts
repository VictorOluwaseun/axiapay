import type {
  ServiceProduct,
  ServiceType,
  ElectricityMeterType,
} from '../../service-catalog/domain/service-product.js';
import {
  money,
  maximumMinorUnits,
  type Money,
} from '../../wallets/domain/money.js';
import type {
  BankBeneficiaryValidation,
  BankTransferFailureReason,
} from './bank-beneficiary.js';
import type { BillAccountValidation } from './bill-account.js';
import type { PaymentFulfilment } from './payment-fulfilment.js';
import type { EducationRecipientValidation } from './education-recipient.js';
import type { InsuranceApplication } from './insurance-application.js';
import { insuredProfileFingerprint } from './insured-profile-fingerprint.js';
import type { PaymentDocument } from './payment-document.js';
import type { InsuranceProductTerms } from '../../service-catalog/domain/insurance-product-terms.js';

/** Stable first-party failures; provider response bodies and storage details remain internal causes. */
export class PaymentError extends Error {
  /** Preserve actionable codes without accepting external error messages into public responses. */
  constructor(
    readonly code:
      | 'INVALID_PAYMENT'
      | 'PRODUCT_UNAVAILABLE'
      | 'QUOTE_NOT_FOUND'
      | 'QUOTE_EXPIRED'
      | 'PAYMENT_NOT_FOUND'
      | 'PAYMENT_CONFLICT'
      | 'PAYMENT_UNAVAILABLE'
      | 'INVALID_PROVIDER_EVIDENCE'
      | 'ACCOUNT_VALIDATION_NOT_FOUND'
      | 'ACCOUNT_VALIDATION_EXPIRED'
      | 'ACCOUNT_INVALID'
      | 'ACCOUNT_UNCONFIRMED'
      | 'EDUCATION_VALIDATION_NOT_FOUND'
      | 'EDUCATION_VALIDATION_EXPIRED'
      | 'EDUCATION_BENEFICIARY_INVALID'
      | 'EDUCATION_BENEFICIARY_UNCONFIRMED'
      | 'INSURANCE_APPLICATION_NOT_FOUND'
      | 'INSURANCE_APPLICATION_EXPIRED'
      | 'INSURANCE_TERMS_CHANGED'
      | 'INSURANCE_INELIGIBLE'
      | 'INSURANCE_UNCONFIRMED'
      | 'DOCUMENT_NOT_FOUND'
      | 'DOCUMENT_UNAVAILABLE'
      | 'BANK_UNAVAILABLE'
      | 'BANK_BENEFICIARY_NOT_FOUND'
      | 'BANK_BENEFICIARY_EXPIRED'
      | 'BANK_BENEFICIARY_INVALID'
      | 'BANK_BENEFICIARY_UNCONFIRMED'
      | 'BANK_TRANSFER_NOT_FOUND',
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = 'PaymentError';
  }
}

/** Require canonical UUIDs at application boundaries, including non-HTTP callers. */
export function assertUuidReference(id: string): void {
  if (
    typeof id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/.test(
      id,
    )
  ) {
    throw new PaymentError('INVALID_PAYMENT');
  }
}

/** Persist one accepted identity across online and future SMS transports; NUL and padded keys are invalid. */
export function assertPaymentRequestKey(key: string): void {
  if (
    typeof key !== 'string' ||
    key.length < 1 ||
    key.length > 200 ||
    key.trim() !== key ||
    key.includes('\u0000')
  ) {
    throw new PaymentError('INVALID_PAYMENT');
  }
}

/** Bind quotes to a canonical international recipient, without guessing country or ported network. */
export function assertRecipientPhoneNumber(phoneNumber: string): void {
  if (
    typeof phoneNumber !== 'string' ||
    !/^\+[1-9][0-9]{7,14}(?![\s\S])/.test(phoneNumber)
  ) {
    throw new PaymentError('INVALID_PAYMENT');
  }
}

/** Immutable owner/wallet-bound review terms. Prices and adapter routing come only from a server catalogue revision. */
export interface PaymentQuote {
  readonly id: string;
  readonly ownerId: string;
  readonly walletId: string;
  readonly productId: string;
  readonly serviceType: ServiceType;
  readonly networkCode: string | null;
  readonly billerCode: string | null;
  readonly electricityMeterType: ElectricityMeterType | null;
  readonly accountValidation: BillAccountValidation | null;
  readonly bankBeneficiaryValidation: BankBeneficiaryValidation | null;
  readonly narration: string | null;
  readonly educationValidation: EducationRecipientValidation | null;
  readonly insuranceApplication: InsuranceApplication | null;
  readonly educationPaymentType: ServiceProduct['educationPaymentType'];
  readonly educationPurpose: string | null;
  readonly insuranceTerms: InsuranceProductTerms | null;
  readonly displayName: string;
  readonly recipientPhoneNumber: string | null;
  readonly principal: Money;
  readonly feeMinorUnits: bigint;
  readonly totalDebitMinorUnits: bigint;
  readonly allowanceLabel: string | null;
  readonly validitySeconds: number | null;
  readonly providerKey: string;
  readonly providerProductCode: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/** Apply the selected revision's variable amount or fixed price, enforcing exact denomination, fee bounds and no client total/price override. */
export function quotePrincipal(
  product: ServiceProduct,
  amountMinorUnits?: bigint,
): Money {
  if (!product.isEnabled) {
    throw new PaymentError('PRODUCT_UNAVAILABLE');
  }
  const hasFixedPrice = product.fixedPriceMinorUnits !== null;
  if (hasFixedPrice && amountMinorUnits !== undefined) {
    throw new PaymentError('INVALID_PAYMENT');
  }
  const principal = hasFixedPrice
    ? product.fixedPriceMinorUnits
    : amountMinorUnits;
  if (
    principal === undefined ||
    principal === null ||
    typeof principal !== 'bigint'
  ) {
    throw new PaymentError('INVALID_PAYMENT');
  }
  if (
    principal < product.minimumAmountMinorUnits ||
    principal > product.maximumAmountMinorUnits ||
    (principal - product.minimumAmountMinorUnits) %
      product.amountStepMinorUnits !==
      0n
  ) {
    throw new PaymentError('INVALID_PAYMENT');
  }
  if (principal + product.feeMinorUnits > maximumMinorUnits) {
    throw new PaymentError('INVALID_PAYMENT');
  }
  return money(principal, product.currency);
}

/** Refuse new financial authorizations at or after expiry; an existing reservation retains its immutable recovery terms. */
export function assertQuoteCurrent(quote: PaymentQuote, now: Date): void {
  if (quote.expiresAt.getTime() <= now.getTime()) {
    throw new PaymentError('QUOTE_EXPIRED');
  }
}

/** Confirmed provider result, recorded only after trusted adapter correlation. Unsafe failures remain unresolved. */
export interface PaymentOutcome {
  readonly outcome: 'succeeded' | 'failed';
  readonly providerTransactionReference: string;
  readonly evidenceReference: string;
  readonly failureReason?: BankTransferFailureReason;
}

/** Durable instruction and actual ledger progress; acceptance, dispatch, provider fulfilment, and wallet settlement are distinct. */
export interface ServicePayment {
  readonly id: string;
  readonly ownerId: string;
  readonly requestKey: string;
  readonly partnerAccountId: string;
  readonly feeAccountId: string | null;
  readonly quote: PaymentQuote;
  readonly createdAt: Date;
  readonly submissionStartedAt: Date | null;
  readonly reservationId: string | null;
  readonly reservationStatus: 'reserved' | 'captured' | 'released' | null;
  readonly outcome: PaymentOutcome | null;
  readonly fulfilment: PaymentFulfilment | null;
  readonly documents: readonly PaymentDocument[];
}

/** Immutable ledger routing accepted with the instruction, independent of later deployment configuration. */
export interface PaymentSettlementAccounts {
  readonly partnerAccountId: string;
  readonly feeAccountId: string | null;
}

/** Public states distinguish missing funds, an unsubmitted hold, uncertainty, and final journal settlement. */
export type PaymentStatus =
  'awaiting_funds' | 'reserved' | 'pending' | 'succeeded' | 'failed';

/** Report final outcomes only when their corresponding capture/release journal has committed. */
export function paymentStatus(payment: ServicePayment): PaymentStatus {
  if (payment.reservationStatus === 'captured') {
    return 'succeeded';
  }
  if (payment.reservationStatus === 'released') {
    return 'failed';
  }
  if (!payment.reservationId) {
    return 'awaiting_funds';
  }
  return payment.submissionStartedAt ? 'pending' : 'reserved';
}

/** Correlate adapter evidence to all immutable first-party fulfilment/financial terms; this is not a credential or signature. */
export function paymentTermsFingerprint(payment: ServicePayment): string {
  const quote = payment.quote;
  const terms = [
    payment.id,
    quote.productId,
    quote.providerKey,
    quote.providerProductCode,
    quote.recipientPhoneNumber,
    quote.principal.currency,
    quote.principal.amountMinorUnits.toString(),
    quote.feeMinorUnits.toString(),
  ];
  if (quote.accountValidation) {
    terms.push(
      quote.accountValidation.id,
      quote.accountValidation.accountNumber,
      quote.billerCode,
      quote.electricityMeterType,
    );
  }
  if (quote.educationValidation) {
    terms.push(
      quote.educationValidation.id,
      quote.educationValidation.beneficiaryIdentifier,
      quote.billerCode,
      quote.educationPaymentType,
      quote.educationPurpose,
    );
  }
  if (quote.insuranceApplication) {
    terms.push(
      quote.insuranceApplication.id,
      insuredProfileFingerprint(quote.insuranceApplication.insuredProfile),
      quote.insuranceApplication.termsVersion,
      quote.insuranceApplication.coverageStartsOn,
      quote.insuranceApplication.coverageEndsOn,
      quote.billerCode,
    );
  }
  if (quote.bankBeneficiaryValidation) {
    terms.push(
      quote.bankBeneficiaryValidation.id,
      quote.bankBeneficiaryValidation.bankId,
      quote.bankBeneficiaryValidation.accountNumber,
      quote.bankBeneficiaryValidation.accountName,
      quote.bankBeneficiaryValidation.currency,
      quote.narration,
    );
  }
  return JSON.stringify(terms);
}
