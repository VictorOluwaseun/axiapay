import {
  PaymentError,
  type PaymentQuote,
  type ServicePayment,
} from './payment.js';
import { assertBillDisplayText } from './bill-account.js';
import { isUnsignedDecimalText } from '../../../shared/domain/numeric-text.js';

/** An ordered printable token returned by authenticated evidence; labels support recharge and meter key-change sequences. */
export interface ElectricityToken {
  readonly label: string;
  readonly value: string;
}

/** Typed first-party receipt details, separate from financial success and containing no provider response blob. */
export type PaymentFulfilment =
  | {
      readonly fulfilmentType: 'bank_transfer';
      readonly transferReference: string;
      readonly creditedAt: string;
      readonly bankId: string;
      readonly accountNumber: string;
      readonly accountName: string;
      readonly amountMinorUnits: string;
      readonly currency: string;
    }
  | {
      readonly fulfilmentType: 'education_fee';
      readonly institutionReference: string;
    }
  | {
      readonly fulfilmentType: 'education_voucher';
      readonly voucherCode: string;
      readonly serialNumber: string | null;
    }
  | {
      readonly fulfilmentType: 'insurance_policy';
      readonly policyNumber: string;
      readonly insuredName: string;
      readonly coverageStartsOn: string;
      readonly coverageEndsOn: string;
    }
  | {
      readonly fulfilmentType: 'tv_subscription';
      readonly activationReference: string;
      readonly renewalAt: string | null;
    }
  | {
      readonly fulfilmentType: 'electricity_prepaid';
      readonly receiptReference: string;
      readonly tokens: readonly ElectricityToken[];
      readonly unitsKilowattHours: string | null;
    }
  | {
      readonly fulfilmentType: 'electricity_postpaid';
      readonly receiptReference: string;
    };

/** A complete service receipt or supported education fee PDF is proof; policy issuance still requires its typed authenticated evidence. */
export function hasPaymentFulfilment(payment: ServicePayment): boolean {
  return (
    payment.fulfilment !== null ||
    (payment.quote.serviceType === 'education' &&
      payment.quote.educationPaymentType === 'institution_fee' &&
      payment.documents.length > 0)
  );
}

/** Successful purchases can precede receipt/policy/documents; missing proof permits lookup of the original instruction, never a repeat purchase. */
export function needsPaymentFulfilment(payment: ServicePayment): boolean {
  if (
    !['tv', 'electricity', 'education', 'insurance'].includes(
      payment.quote.serviceType,
    ) ||
    payment.outcome?.outcome !== 'succeeded'
  ) {
    return false;
  }
  return (
    !hasPaymentFulfilment(payment) ||
    (payment.quote.serviceType === 'insurance' &&
      payment.documents.length === 0)
  );
}

/** Validate and project a matching receipt before storage, preserving exact token/unit strings and rejecting incompatible bill modes. */
export function validatedPaymentFulfilment(
  quote: PaymentQuote,
  fulfilment: PaymentFulfilment,
): PaymentFulfilment {
  if (!fulfilment || typeof fulfilment !== 'object') {
    throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
  }
  if (quote.serviceType === 'bank_transfer') {
    return validatedBankTransferFulfilment(quote, fulfilment);
  }
  if (quote.serviceType === 'education') {
    return validatedEducationFulfilment(quote, fulfilment);
  }
  if (quote.serviceType === 'insurance') {
    return validatedInsuranceFulfilment(quote, fulfilment);
  }
  if (
    quote.serviceType === 'tv' &&
    fulfilment.fulfilmentType === 'tv_subscription'
  ) {
    return validatedTvFulfilment(fulfilment);
  }
  if (
    quote.serviceType === 'electricity' &&
    quote.electricityMeterType === 'prepaid' &&
    fulfilment.fulfilmentType === 'electricity_prepaid'
  ) {
    return validatedPrepaidFulfilment(fulfilment);
  }
  if (
    quote.serviceType === 'electricity' &&
    quote.electricityMeterType === 'postpaid' &&
    fulfilment.fulfilmentType === 'electricity_postpaid'
  ) {
    assertBillDisplayText(fulfilment.receiptReference, 200);
    return {
      fulfilmentType: 'electricity_postpaid',
      receiptReference: fulfilment.receiptReference,
    };
  }
  throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
}

/** Match the configured education delivery type, retaining secret voucher codes only in the authenticated payment resource. */
function validatedEducationFulfilment(
  quote: PaymentQuote,
  fulfilment: PaymentFulfilment,
): PaymentFulfilment {
  if (
    quote.educationPaymentType === 'institution_fee' &&
    fulfilment.fulfilmentType === 'education_fee'
  ) {
    assertBillDisplayText(fulfilment.institutionReference, 200);
    return {
      fulfilmentType: 'education_fee',
      institutionReference: fulfilment.institutionReference,
    };
  }
  if (
    quote.educationPaymentType !== 'voucher' ||
    fulfilment.fulfilmentType !== 'education_voucher'
  ) {
    throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
  }
  assertBillDisplayText(fulfilment.voucherCode, 200);
  if (fulfilment.serialNumber !== null) {
    assertBillDisplayText(fulfilment.serialNumber, 200);
  }
  return {
    fulfilmentType: 'education_voucher',
    voucherCode: fulfilment.voucherCode,
    serialNumber: fulfilment.serialNumber,
  };
}

/** Record issuance only for the exact eligible insured person and requested period; premium payment alone cannot create this proof. */
function validatedInsuranceFulfilment(
  quote: PaymentQuote,
  fulfilment: PaymentFulfilment,
): PaymentFulfilment {
  const application = quote.insuranceApplication;
  if (
    fulfilment.fulfilmentType !== 'insurance_policy' ||
    !application ||
    fulfilment.insuredName !== application.insuredProfile.fullName ||
    fulfilment.coverageStartsOn !== application.coverageStartsOn ||
    fulfilment.coverageEndsOn !== application.coverageEndsOn
  ) {
    throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
  }
  assertBillDisplayText(fulfilment.policyNumber, 200);
  return {
    fulfilmentType: 'insurance_policy',
    policyNumber: fulfilment.policyNumber,
    insuredName: fulfilment.insuredName,
    coverageStartsOn: fulfilment.coverageStartsOn,
    coverageEndsOn: fulfilment.coverageEndsOn,
  };
}

/** Retain only actual provider-supplied renewal information; never calculate a renewal date from a payment timestamp. */
function validatedTvFulfilment(
  fulfilment: Extract<PaymentFulfilment, { fulfilmentType: 'tv_subscription' }>,
): PaymentFulfilment {
  assertBillDisplayText(fulfilment.activationReference, 200);
  if (fulfilment.renewalAt === null) {
    return {
      fulfilmentType: 'tv_subscription',
      activationReference: fulfilment.activationReference,
      renewalAt: null,
    };
  }
  if (
    typeof fulfilment.renewalAt !== 'string' ||
    fulfilment.renewalAt.length !== 24
  ) {
    throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
  }
  const renewal = new Date(fulfilment.renewalAt);
  if (
    !Number.isFinite(renewal.getTime()) ||
    renewal.toISOString() !== fulfilment.renewalAt
  ) {
    throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
  }
  return {
    fulfilmentType: 'tv_subscription',
    activationReference: fulfilment.activationReference,
    renewalAt: fulfilment.renewalAt,
  };
}

/** Preserve token order and exact optional kWh decimals, accepting no invented token or binary-floating-point unit count. */
function validatedPrepaidFulfilment(
  fulfilment: Extract<
    PaymentFulfilment,
    { fulfilmentType: 'electricity_prepaid' }
  >,
): PaymentFulfilment {
  assertBillDisplayText(fulfilment.receiptReference, 200);
  if (
    !Array.isArray(fulfilment.tokens) ||
    fulfilment.tokens.length < 1 ||
    fulfilment.tokens.length > 8
  ) {
    throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
  }
  const tokens = fulfilment.tokens.map(validatedElectricityToken);
  if (new Set(tokens.map((token) => token.value)).size !== tokens.length) {
    throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
  }
  if (
    fulfilment.unitsKilowattHours !== null &&
    (typeof fulfilment.unitsKilowattHours !== 'string' ||
      !isUnsignedDecimalText(fulfilment.unitsKilowattHours, 18, 9))
  ) {
    throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
  }
  return {
    fulfilmentType: 'electricity_prepaid',
    receiptReference: fulfilment.receiptReference,
    tokens,
    unitsKilowattHours: fulfilment.unitsKilowattHours,
  };
}

/** Project each bounded token without exposing extra upstream fields. */
function validatedElectricityToken(token: ElectricityToken): ElectricityToken {
  if (!token || typeof token !== 'object') {
    throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
  }
  assertBillDisplayText(token.label, 100);
  assertBillDisplayText(token.value, 128);
  return { label: token.label, value: token.value };
}

/** Require independently confirmed recipient credit for exactly the accepted bank account and principal before any financial success can be saved. */
export function validatedBankTransferFulfilment(
  quote: PaymentQuote,
  fulfilment: PaymentFulfilment | undefined,
): Extract<PaymentFulfilment, { fulfilmentType: 'bank_transfer' }> {
  const beneficiary = quote.bankBeneficiaryValidation;
  if (
    !fulfilment ||
    fulfilment.fulfilmentType !== 'bank_transfer' ||
    !beneficiary ||
    fulfilment.bankId !== beneficiary.bankId ||
    fulfilment.accountNumber !== beneficiary.accountNumber ||
    fulfilment.accountName !== beneficiary.accountName ||
    fulfilment.currency !== quote.principal.currency ||
    fulfilment.amountMinorUnits !== quote.principal.amountMinorUnits.toString()
  ) {
    throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
  }
  assertBillDisplayText(fulfilment.transferReference, 200);
  if (
    typeof fulfilment.creditedAt !== 'string' ||
    fulfilment.creditedAt.length !== 24
  ) {
    throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
  }
  const creditedAt = new Date(fulfilment.creditedAt);
  if (
    !Number.isFinite(creditedAt.getTime()) ||
    creditedAt.toISOString() !== fulfilment.creditedAt
  ) {
    throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
  }
  return {
    fulfilmentType: 'bank_transfer',
    transferReference: fulfilment.transferReference,
    creditedAt: fulfilment.creditedAt,
    bankId: fulfilment.bankId,
    accountNumber: fulfilment.accountNumber,
    accountName: fulfilment.accountName,
    amountMinorUnits: fulfilment.amountMinorUnits,
    currency: fulfilment.currency,
  };
}
