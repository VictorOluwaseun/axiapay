import { ApiProperty, ApiExtraModels, getSchemaPath } from '@nestjs/swagger';
import { HttpErrorResponseDto } from '../../../shared/http/http-error-response.dto.js';
import {
  BankBeneficiaryValidationResponseDto,
  BankTransferConfirmationResponseDto,
} from './bank-transfer.dto.js';
import { BillAccountValidationResponseDto } from './bill-account.dto.js';
import {
  TvFulfilmentResponseDto,
  PrepaidElectricityFulfilmentResponseDto,
  PostpaidElectricityFulfilmentResponseDto,
  EducationFeeFulfilmentResponseDto,
  EducationVoucherFulfilmentResponseDto,
  InsurancePolicyFulfilmentResponseDto,
} from './payment-fulfilment.dto.js';
import {
  EducationValidationResponseDto,
  InsuranceApplicationResponseDto,
  InsuranceTermsResponseDto,
} from './education-insurance.dto.js';
import { hasPaymentFulfilment } from '@axiapay/payments-runtime/modules/payments/domain/payment-fulfilment';
import type { PaymentFulfilment } from '@axiapay/payments-runtime/modules/payments/domain/payment-fulfilment';
import type {
  PaymentQuote,
  PaymentStatus,
  ServicePayment,
} from '@axiapay/payments-runtime/modules/payments/domain/payment';
import { paymentStatus } from '@axiapay/payments-runtime/modules/payments/domain/payment';
import type { ServiceProduct } from '@axiapay/payments-runtime/modules/service-catalog/domain/service-product';

/** Customer-facing product revision excludes adapter routing and exposes exact plan/denomination terms. */
export class ServiceProductResponseDto {
  @ApiProperty({ format: 'uuid' }) readonly id!: string;
  @ApiProperty({
    enum: [
      'airtime',
      'data',
      'tv',
      'electricity',
      'education',
      'insurance',
      'bank_transfer',
    ],
  })
  readonly serviceType!: string;
  @ApiProperty({ type: String, nullable: true }) readonly networkCode!:
    string | null;
  @ApiProperty({ type: String, nullable: true }) readonly billerCode!:
    string | null;
  @ApiProperty({ type: String, enum: ['prepaid', 'postpaid'], nullable: true })
  readonly electricityMeterType!: string | null;
  @ApiProperty({
    type: String,
    enum: ['institution_fee', 'voucher'],
    nullable: true,
  })
  readonly educationPaymentType!: string | null;
  @ApiProperty({ type: String, nullable: true }) readonly educationPurpose!:
    string | null;
  @ApiProperty({ type: InsuranceTermsResponseDto, nullable: true })
  readonly insuranceTerms!: InsuranceTermsResponseDto | null;
  @ApiProperty() readonly displayName!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  readonly bankId!: string | null;
  @ApiProperty({ example: 'NGN' }) readonly currency!: string;
  @ApiProperty({ type: String, nullable: true })
  readonly fixedPriceMinorUnits!: string | null;
  @ApiProperty({ type: String }) readonly minimumAmountMinorUnits!: string;
  @ApiProperty({ type: String }) readonly maximumAmountMinorUnits!: string;
  @ApiProperty({ type: String }) readonly amountStepMinorUnits!: string;
  @ApiProperty({ type: String }) readonly feeMinorUnits!: string;
  @ApiProperty({ type: String, nullable: true }) readonly allowanceLabel!:
    string | null;
  @ApiProperty({ type: Number, nullable: true }) readonly validitySeconds!:
    number | null;
  @ApiProperty({
    description:
      'False when no fulfilment adapter is registered. Catalogue publication alone does not enable a purchase.',
  })
  readonly isSubmissionAvailable!: boolean;

  /** Project only first-party display/pricing terms; never leak upstream SKUs or ledger accounts. */
  static fromProduct(
    product: ServiceProduct,
    isSubmissionAvailable: boolean,
  ): ServiceProductResponseDto {
    return {
      id: product.id,
      serviceType: product.serviceType,
      networkCode: product.networkCode,
      billerCode: product.billerCode,
      electricityMeterType: product.electricityMeterType,
      educationPaymentType: product.educationPaymentType,
      educationPurpose: product.educationPurpose,
      insuranceTerms: product.insuranceTerms
        ? InsuranceTermsResponseDto.fromTerms(product.insuranceTerms)
        : null,
      displayName: product.displayName,
      bankId: product.bankId,
      currency: product.currency,
      fixedPriceMinorUnits: product.fixedPriceMinorUnits?.toString() ?? null,
      minimumAmountMinorUnits: product.minimumAmountMinorUnits.toString(),
      maximumAmountMinorUnits: product.maximumAmountMinorUnits.toString(),
      amountStepMinorUnits: product.amountStepMinorUnits.toString(),
      feeMinorUnits: product.feeMinorUnits.toString(),
      allowanceLabel: product.allowanceLabel,
      validitySeconds: product.validitySeconds,
      isSubmissionAvailable,
    };
  }
}

/** Stable catalogue pagination contract; callers retain their filters when following the cursor. */
export class ServiceProductPageResponseDto {
  @ApiProperty({ type: [ServiceProductResponseDto] })
  readonly products!: ServiceProductResponseDto[];
  @ApiProperty({ type: String, nullable: true }) readonly nextCursor!:
    string | null;
}

/** Exact immutable payment-review terms; this projection proves neither provider fulfilment nor wallet settlement. */
export class PaymentReviewResponseDto {
  @ApiProperty({ format: 'uuid' }) readonly id!: string;
  @ApiProperty({ format: 'uuid' }) readonly walletId!: string;
  @ApiProperty({ format: 'uuid' }) readonly productId!: string;
  @ApiProperty({
    enum: [
      'airtime',
      'data',
      'tv',
      'electricity',
      'education',
      'insurance',
      'bank_transfer',
    ],
  })
  readonly serviceType!: string;
  @ApiProperty({ type: String, nullable: true }) readonly networkCode!:
    string | null;
  @ApiProperty({ type: String, nullable: true }) readonly billerCode!:
    string | null;
  @ApiProperty({ type: String, enum: ['prepaid', 'postpaid'], nullable: true })
  readonly electricityMeterType!: string | null;
  @ApiProperty({ type: BillAccountValidationResponseDto, nullable: true })
  readonly accountValidation!: BillAccountValidationResponseDto | null;
  @ApiProperty({ type: BankBeneficiaryValidationResponseDto, nullable: true })
  readonly bankBeneficiaryValidation!: BankBeneficiaryValidationResponseDto | null;
  @ApiProperty({ type: String, nullable: true }) readonly narration!:
    string | null;
  @ApiProperty({ type: EducationValidationResponseDto, nullable: true })
  readonly educationValidation!: EducationValidationResponseDto | null;
  @ApiProperty({ type: InsuranceApplicationResponseDto, nullable: true })
  readonly insuranceApplication!: InsuranceApplicationResponseDto | null;
  @ApiProperty({
    type: String,
    enum: ['institution_fee', 'voucher'],
    nullable: true,
  })
  readonly educationPaymentType!: string | null;
  @ApiProperty({ type: String, nullable: true }) readonly educationPurpose!:
    string | null;
  @ApiProperty({ type: InsuranceTermsResponseDto, nullable: true })
  readonly insuranceTerms!: InsuranceTermsResponseDto | null;
  @ApiProperty() readonly displayName!: string;
  @ApiProperty({ type: String, nullable: true })
  readonly recipientPhoneNumber!: string | null;
  @ApiProperty({ example: 'NGN' }) readonly currency!: string;
  @ApiProperty({ type: String }) readonly principalMinorUnits!: string;
  @ApiProperty({ type: String }) readonly feeMinorUnits!: string;
  @ApiProperty({ type: String }) readonly totalDebitMinorUnits!: string;
  @ApiProperty({ type: String, nullable: true }) readonly allowanceLabel!:
    string | null;
  @ApiProperty({ type: Number, nullable: true }) readonly validitySeconds!:
    number | null;
  @ApiProperty({ format: 'date-time' }) readonly createdAt!: string;
  @ApiProperty({ format: 'date-time' }) readonly expiresAt!: string;

  /** Serialize bigint amounts exactly and return only the authenticated customer's review terms. */
  static fromQuote(quote: PaymentQuote): PaymentReviewResponseDto {
    return {
      id: quote.id,
      walletId: quote.walletId,
      productId: quote.productId,
      serviceType: quote.serviceType,
      networkCode: quote.networkCode,
      billerCode: quote.billerCode,
      electricityMeterType: quote.electricityMeterType,
      accountValidation: quote.accountValidation
        ? BillAccountValidationResponseDto.fromValidation(
            quote.accountValidation,
          )
        : null,
      educationValidation: quote.educationValidation
        ? EducationValidationResponseDto.fromValidation(
            quote.educationValidation,
          )
        : null,
      insuranceApplication: quote.insuranceApplication
        ? InsuranceApplicationResponseDto.fromApplication(
            quote.insuranceApplication,
          )
        : null,
      educationPaymentType: quote.educationPaymentType,
      educationPurpose: quote.educationPurpose,
      insuranceTerms: quote.insuranceTerms
        ? InsuranceTermsResponseDto.fromTerms(quote.insuranceTerms)
        : null,
      bankBeneficiaryValidation: quote.bankBeneficiaryValidation
        ? BankBeneficiaryValidationResponseDto.fromValidation(
            quote.bankBeneficiaryValidation,
          )
        : null,
      narration: quote.narration,
      displayName: quote.displayName,
      recipientPhoneNumber: quote.recipientPhoneNumber,
      currency: quote.principal.currency,
      principalMinorUnits: quote.principal.amountMinorUnits.toString(),
      feeMinorUnits: quote.feeMinorUnits.toString(),
      totalDebitMinorUnits: quote.totalDebitMinorUnits.toString(),
      allowanceLabel: quote.allowanceLabel,
      validitySeconds: quote.validitySeconds,
      createdAt: quote.createdAt.toISOString(),
      expiresAt: quote.expiresAt.toISOString(),
    };
  }
}

/** Review response distinguishes priced terms from deployment/expiry eligibility to submit. */
export class PaymentQuoteResponseDto extends PaymentReviewResponseDto {
  @ApiProperty() readonly isSubmissionAvailable!: boolean;
}

/** Owner-authorized document descriptor; download paths contain first-party identities and never a private upstream URL/reference. */
export class PaymentDocumentResponseDto {
  @ApiProperty() readonly documentId!: string;
  @ApiProperty({ enum: ['education_receipt', 'policy', 'certificate'] })
  readonly documentType!: string;
  @ApiProperty() readonly displayName!: string;
  @ApiProperty({ enum: ['application/pdf'] })
  readonly contentType!: 'application/pdf';
  @ApiProperty() readonly downloadPath!: string;
}

/** Safe observable progress. Final success/failure requires a committed capture/release, not an SMS or submission acknowledgement. */
@ApiExtraModels(
  TvFulfilmentResponseDto,
  PrepaidElectricityFulfilmentResponseDto,
  PostpaidElectricityFulfilmentResponseDto,
  EducationFeeFulfilmentResponseDto,
  EducationVoucherFulfilmentResponseDto,
  InsurancePolicyFulfilmentResponseDto,
  BankTransferConfirmationResponseDto,
)
export class ServicePaymentResponseDto {
  @ApiProperty({ format: 'uuid' }) readonly id!: string;
  @ApiProperty() readonly requestKey!: string;
  @ApiProperty({
    enum: ['awaiting_funds', 'reserved', 'pending', 'succeeded', 'failed'],
  })
  readonly paymentStatus!: PaymentStatus;
  @ApiProperty({
    enum: ['not_applicable', 'not_available', 'pending', 'available'],
    description:
      'Receipt/token retrieval is separate from financial success; a delayed receipt must not prompt another purchase.',
  })
  readonly fulfilmentStatus!:
    'not_applicable' | 'not_available' | 'pending' | 'available';
  @ApiProperty({
    nullable: true,
    oneOf: [
      TvFulfilmentResponseDto,
      PrepaidElectricityFulfilmentResponseDto,
      PostpaidElectricityFulfilmentResponseDto,
      EducationFeeFulfilmentResponseDto,
      EducationVoucherFulfilmentResponseDto,
      InsurancePolicyFulfilmentResponseDto,
      BankTransferConfirmationResponseDto,
    ].map((responseType) => ({ $ref: getSchemaPath(responseType) })),
  })
  readonly fulfilment!: PaymentFulfilment | null;
  @ApiProperty({
    enum: [
      'not_applicable',
      'awaiting_payment',
      'awaiting_issuance',
      'issued',
      'not_issued',
    ],
    description:
      'Issued requires authenticated policy evidence, and does not assert currently active coverage.',
  })
  readonly policyIssuanceStatus!:
    | 'not_applicable'
    | 'awaiting_payment'
    | 'awaiting_issuance'
    | 'issued'
    | 'not_issued';
  @ApiProperty({
    enum: ['not_applicable', 'not_available', 'pending', 'available'],
  })
  readonly documentStatus!:
    'not_applicable' | 'not_available' | 'pending' | 'available';
  @ApiProperty({ type: [PaymentDocumentResponseDto] })
  readonly documents!: PaymentDocumentResponseDto[];
  @ApiProperty({ type: PaymentReviewResponseDto })
  readonly quote!: PaymentReviewResponseDto;
  @ApiProperty({ format: 'date-time' }) readonly createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readonly submissionStartedAt!: string | null;

  /** Return first-party progress without exposing internal evidence or partner ledger configuration. */
  static fromPayment(payment: ServicePayment): ServicePaymentResponseDto {
    return {
      id: payment.id,
      requestKey: payment.requestKey,
      paymentStatus: paymentStatus(payment),
      fulfilmentStatus: paymentFulfilmentStatus(payment),
      fulfilment: payment.fulfilment,
      policyIssuanceStatus: policyIssuanceStatus(payment),
      documentStatus: paymentDocumentStatus(payment),
      documents: payment.documents.map((document) => ({
        documentId: document.documentId,
        documentType: document.documentType,
        displayName: document.displayName,
        contentType: document.contentType,
        downloadPath: `/v1/payments/${payment.id}/documents/${document.documentId}`,
      })),
      quote: PaymentReviewResponseDto.fromQuote(payment.quote),
      createdAt: payment.createdAt.toISOString(),
      submissionStartedAt: payment.submissionStartedAt?.toISOString() ?? null,
    };
  }
}

/** Project independent receipt retrieval state without converting a missing token into a failed or repeatable payment. */
function paymentFulfilmentStatus(
  payment: ServicePayment,
): ServicePaymentResponseDto['fulfilmentStatus'] {
  if (
    !['tv', 'electricity', 'education', 'insurance', 'bank_transfer'].includes(
      payment.quote.serviceType,
    )
  ) {
    return 'not_applicable';
  }
  if (payment.outcome?.outcome !== 'succeeded') {
    return 'not_available';
  }
  return hasPaymentFulfilment(payment) ? 'available' : 'pending';
}

/** Actionable, redacted error contract shared by catalogue, quote and submission routes. */
export class PaymentErrorResponseDto extends HttpErrorResponseDto {}

/** Derive issuance solely from an authenticated stored policy, independent of the ledger's financial state. */
function policyIssuanceStatus(
  payment: ServicePayment,
): ServicePaymentResponseDto['policyIssuanceStatus'] {
  if (payment.quote.serviceType !== 'insurance') {
    return 'not_applicable';
  }
  if (payment.fulfilment?.fulfilmentType === 'insurance_policy') {
    return 'issued';
  }
  if (payment.outcome?.outcome === 'failed') {
    return 'not_issued';
  }
  if (payment.outcome?.outcome === 'succeeded') {
    return 'awaiting_issuance';
  }
  return 'awaiting_payment';
}

/** Document descriptors establish recorded proof, while premium confirmation establishes whether issuance/document delivery is pending. */
function paymentDocumentStatus(
  payment: ServicePayment,
): ServicePaymentResponseDto['documentStatus'] {
  if (payment.documents.length > 0) {
    return 'available';
  }
  if (payment.quote.serviceType !== 'insurance') {
    return 'not_applicable';
  }
  return payment.outcome?.outcome === 'succeeded' ? 'pending' : 'not_available';
}
