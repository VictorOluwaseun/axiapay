import { IsReadableText } from '../../../shared/validation/input-constraints.js';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNumberString,
  IsUUID,
  Length,
  Matches,
  ValidateIf,
} from 'class-validator';
import type {
  Bank,
  BankPage,
} from '@axiapay/payments-runtime/modules/service-catalog/domain/bank';
import type { ServiceProduct } from '@axiapay/payments-runtime/modules/service-catalog/domain/service-product';
import type {
  BankBeneficiaryValidation,
  BankTransferFailureReason,
} from '@axiapay/payments-runtime/modules/payments/domain/bank-beneficiary';
import type { PaymentFulfilment } from '@axiapay/payments-runtime/modules/payments/domain/payment-fulfilment';
import {
  paymentStatus,
  type PaymentQuote,
  type PaymentStatus,
  type ServicePayment,
} from '@axiapay/payments-runtime/modules/payments/domain/payment';
import { SubmitServicePaymentDto } from './payment-request.dto.js';

/** Bounded first-party bank/transfer catalogue pagination; no implicit query conversion or arbitrary sorting is permitted. */
export class BankTransferPageQueryDto {
  @ApiPropertyOptional({ example: 'NGN' })
  @ValidateIf((_object, value) => value !== undefined)
  @Matches(/^[A-Z]{3}(?![\s\S])/)
  readonly currency?: string;
  @ApiPropertyOptional({ format: 'uuid' })
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  readonly afterId?: string;
  @ApiPropertyOptional({ type: String, default: '50' })
  @ValidateIf((_object, value) => value !== undefined)
  @Matches(/^(?:[1-9][0-9]?|100)(?![\s\S])/)
  readonly limit?: string;
}

/** Directory query identity includes country and currency; publication does not itself connect a provider. */
export class BankDirectoryQueryDto extends BankTransferPageQueryDto {
  @ApiPropertyOptional({ example: 'NG' })
  @ValidateIf((_object, value) => value !== undefined)
  @Matches(/^[A-Z]{2}(?![\s\S])/)
  readonly countryCode?: string;
}

/** Discover only bank transfer pricing/routing revisions; the service type is fixed by the server. */
export class BankTransferProductQueryDto extends BankTransferPageQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  readonly bankId?: string;
}

/** Canonical first-party bank revision identifier, with no upstream code interpretation. */
export class BankIdParamsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  readonly bankId!: string;
}

/** Non-financial name enquiry request binds exact account identifiers to a selected transfer product and bank. */
export class CreateBankBeneficiaryValidationDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  readonly productId!: string;
  @ApiProperty({
    type: String,
    example: '0012345678',
    description:
      'Numeric account identifier, preserving leading zeros. The selected bank profile defines valid length.',
  })
  @IsNumberString({ no_symbols: true })
  @Length(1, 34)
  readonly accountNumber!: string;
}

/** Owner-scoped enquiry identifier; guessed UUIDs cannot expose another customer's account details. */
export class BankBeneficiaryIdParamsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  readonly validationId!: string;
}

/** Explicit transfer review inputs; the recipient comes only from server verification and fees/limits come only from the selected revision. */
export class CreateBankTransferQuoteDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  readonly walletId!: string;
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  readonly productId!: string;
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  readonly bankBeneficiaryValidationId!: string;
  @ApiProperty({
    type: String,
    example: '10000',
    description:
      'Exact recipient principal in currency minor units. Server fees are added to the wallet debit.',
  })
  @Matches(/^[1-9][0-9]{0,18}(?![\s\S])/)
  readonly amountMinorUnits!: string;
  @ApiPropertyOptional({ minLength: 1, maxLength: 140 })
  @ValidateIf((_object, value) => value !== undefined)
  @Length(1, 140)
  @IsReadableText()
  readonly narration?: string;
}

/** Consent to one immutable transfer quote; persist the original logical request key across response loss and transport changes. */
export class SubmitBankTransferDto extends SubmitServicePaymentDto {}

/** First-party transfer identity is the shared durable payment identity; clients never supply a provider movement reference. */
export class BankTransferIdParamsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  readonly transferId!: string;
}

/** Published immutable bank profile, excluding internal publication/routing state and provider identifiers. */
export class BankResponseDto {
  @ApiProperty({ format: 'uuid' }) readonly id!: string;
  @ApiProperty() readonly bankCode!: string;
  @ApiProperty() readonly displayName!: string;
  @ApiProperty() readonly countryCode!: string;
  @ApiProperty() readonly currency!: string;
  @ApiProperty() readonly minimumAccountNumberLength!: number;
  @ApiProperty() readonly maximumAccountNumberLength!: number;
  /** Whitelist first-party directory information; no adapter lookup or account verification is implied. */
  static fromBank(bank: Bank): BankResponseDto {
    return {
      id: bank.id,
      bankCode: bank.bankCode,
      displayName: bank.displayName,
      countryCode: bank.countryCode,
      currency: bank.currency,
      minimumAccountNumberLength: bank.minimumAccountNumberLength,
      maximumAccountNumberLength: bank.maximumAccountNumberLength,
    };
  }
}

/** Stable directory page contract; follow cursors with the original effective filters. */
export class BankPageResponseDto {
  @ApiProperty({ type: [BankResponseDto] }) readonly banks!: BankResponseDto[];
  @ApiProperty({ type: String, nullable: true }) readonly nextCursor!:
    string | null;
  /** Project a bounded bank page without exposing private catalogue storage metadata. */
  static fromPage(page: BankPage): BankPageResponseDto {
    return {
      banks: page.banks.map(BankResponseDto.fromBank),
      nextCursor: page.nextCursor,
    };
  }
}

/** Server-owned variable transfer amount limits and fixed fee; publication and adapter readiness remain separate. */
export class BankTransferProductResponseDto {
  @ApiProperty({ format: 'uuid' }) readonly id!: string;
  @ApiProperty({ format: 'uuid' }) readonly bankId!: string;
  @ApiProperty() readonly displayName!: string;
  @ApiProperty() readonly currency!: string;
  @ApiProperty({ type: String }) readonly minimumAmountMinorUnits!: string;
  @ApiProperty({ type: String }) readonly maximumAmountMinorUnits!: string;
  @ApiProperty({ type: String }) readonly amountStepMinorUnits!: string;
  @ApiProperty({ type: String }) readonly feeMinorUnits!: string;
  @ApiProperty() readonly isSubmissionAvailable!: boolean;
  /** Expose recipient amount limits and the exact fee, omitting provider SKUs and ledger accounts. */
  static fromProduct(
    product: ServiceProduct,
    isSubmissionAvailable: boolean,
  ): BankTransferProductResponseDto {
    return {
      id: product.id,
      bankId: product.bankId!,
      displayName: product.displayName,
      currency: product.currency,
      minimumAmountMinorUnits: product.minimumAmountMinorUnits.toString(),
      maximumAmountMinorUnits: product.maximumAmountMinorUnits.toString(),
      amountStepMinorUnits: product.amountStepMinorUnits.toString(),
      feeMinorUnits: product.feeMinorUnits.toString(),
      isSubmissionAvailable,
    };
  }
}

/** Bounded transfer product discovery response, retaining first-party revision identities. */
export class BankTransferProductPageResponseDto {
  @ApiProperty({ type: [BankTransferProductResponseDto] })
  readonly products!: BankTransferProductResponseDto[];
  @ApiProperty({ type: String, nullable: true }) readonly nextCursor!:
    string | null;
}

/** Owner-only verified account name and bank snapshot, with visible expiry and no private name-enquiry evidence. */
export class BankBeneficiaryValidationResponseDto {
  @ApiProperty({ format: 'uuid' }) readonly id!: string;
  @ApiProperty({ format: 'uuid' }) readonly productId!: string;
  @ApiProperty({ format: 'uuid' }) readonly bankId!: string;
  @ApiProperty() readonly bankCode!: string;
  @ApiProperty() readonly bankName!: string;
  @ApiProperty() readonly countryCode!: string;
  @ApiProperty() readonly currency!: string;
  @ApiProperty() readonly accountNumber!: string;
  @ApiProperty() readonly accountName!: string;
  @ApiProperty({ format: 'date-time' }) readonly verifiedAt!: string;
  @ApiProperty({ format: 'date-time' }) readonly expiresAt!: string;
  /** Preserve exact verified recipient details for review/recovery without leaking evidence or owner IDs. */
  static fromValidation(
    validation: BankBeneficiaryValidation,
  ): BankBeneficiaryValidationResponseDto {
    return {
      id: validation.id,
      productId: validation.productId,
      bankId: validation.bankId,
      bankCode: validation.bankCode,
      bankName: validation.bankName,
      countryCode: validation.countryCode,
      currency: validation.currency,
      accountNumber: validation.accountNumber,
      accountName: validation.accountName,
      verifiedAt: validation.verifiedAt.toISOString(),
      expiresAt: validation.expiresAt.toISOString(),
    };
  }
}

/** Immutable recipient and wallet debit review; creation performs no transfer or wallet hold. */
export class BankTransferReviewResponseDto {
  @ApiProperty({ format: 'uuid' }) readonly id!: string;
  @ApiProperty({ format: 'uuid' }) readonly walletId!: string;
  @ApiProperty({ format: 'uuid' }) readonly productId!: string;
  @ApiProperty({ type: BankBeneficiaryValidationResponseDto })
  readonly beneficiary!: BankBeneficiaryValidationResponseDto;
  @ApiProperty() readonly currency!: string;
  @ApiProperty({ type: String }) readonly amountMinorUnits!: string;
  @ApiProperty({ type: String }) readonly feeMinorUnits!: string;
  @ApiProperty({ type: String }) readonly totalDebitMinorUnits!: string;
  @ApiProperty({ type: String, nullable: true }) readonly narration!:
    string | null;
  @ApiProperty({ format: 'date-time' }) readonly createdAt!: string;
  @ApiProperty({ format: 'date-time' }) readonly expiresAt!: string;
  /** Serialize exact first-party terms only after the application has established the bank-transfer category and owner. */
  static fromQuote(quote: PaymentQuote): BankTransferReviewResponseDto {
    return {
      id: quote.id,
      walletId: quote.walletId,
      productId: quote.productId,
      beneficiary: BankBeneficiaryValidationResponseDto.fromValidation(
        quote.bankBeneficiaryValidation!,
      ),
      currency: quote.principal.currency,
      amountMinorUnits: quote.principal.amountMinorUnits.toString(),
      feeMinorUnits: quote.feeMinorUnits.toString(),
      totalDebitMinorUnits: quote.totalDebitMinorUnits.toString(),
      narration: quote.narration,
      createdAt: quote.createdAt.toISOString(),
      expiresAt: quote.expiresAt.toISOString(),
    };
  }
}

/** Quote readiness is distinct from recipient verification, accepted spending authorization or live provider health. */
export class BankTransferQuoteResponseDto extends BankTransferReviewResponseDto {
  @ApiProperty() readonly isSubmissionAvailable!: boolean;
}

/** Authenticated completed recipient credit for the accepted account and principal; acknowledgement or provider debit alone cannot create this receipt. */
export class BankTransferConfirmationResponseDto {
  @ApiProperty({ enum: ['bank_transfer'] })
  readonly fulfilmentType!: 'bank_transfer';
  @ApiProperty() readonly transferReference!: string;
  @ApiProperty({ format: 'date-time' }) readonly creditedAt!: string;
  @ApiProperty({ format: 'uuid' }) readonly bankId!: string;
  @ApiProperty() readonly accountNumber!: string;
  @ApiProperty() readonly accountName!: string;
  @ApiProperty({ type: String }) readonly amountMinorUnits!: string;
  @ApiProperty() readonly currency!: string;
}

/** Owner-visible transfer progress and separate actual funds state; final success requires recipient credit proof and committed wallet capture. */
export class BankTransferResponseDto {
  @ApiProperty({ format: 'uuid' }) readonly id!: string;
  @ApiProperty() readonly requestKey!: string;
  @ApiProperty({
    enum: ['awaiting_funds', 'reserved', 'pending', 'succeeded', 'failed'],
  })
  readonly transferStatus!: PaymentStatus;
  @ApiProperty({
    enum: ['unconfirmed', 'credited', 'failed'],
    description:
      'Authenticated receiving-bank outcome, independent of pending wallet journal completion.',
  })
  readonly bankOutcome!: 'unconfirmed' | 'credited' | 'failed';
  @ApiProperty({ enum: ['not_reserved', 'reserved', 'debited', 'released'] })
  readonly fundsStatus!: 'not_reserved' | 'reserved' | 'debited' | 'released';
  @ApiProperty({
    type: String,
    enum: [
      'bank_rejected',
      'recipient_unavailable',
      'account_restricted',
      'transfer_not_completed',
    ],
    nullable: true,
  })
  readonly failureReason!: BankTransferFailureReason | null;
  @ApiProperty({ type: BankTransferReviewResponseDto })
  readonly quote!: BankTransferReviewResponseDto;
  @ApiProperty({ type: BankTransferConfirmationResponseDto, nullable: true })
  readonly confirmation!: Extract<
    PaymentFulfilment,
    { fulfilmentType: 'bank_transfer' }
  > | null;
  @ApiProperty({ format: 'date-time' }) readonly createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readonly submissionStartedAt!: string | null;
  /** Project actual journal progress and immutable credit evidence, omitting provider movement/evidence and internal clearing accounts. */
  static fromTransfer(payment: ServicePayment): BankTransferResponseDto {
    return {
      id: payment.id,
      requestKey: payment.requestKey,
      transferStatus: paymentStatus(payment),
      bankOutcome: transferBankOutcome(payment),
      fundsStatus: transferFundsStatus(payment),
      failureReason: payment.outcome?.failureReason ?? null,
      quote: BankTransferReviewResponseDto.fromQuote(payment.quote),
      confirmation:
        payment.fulfilment?.fulfilmentType === 'bank_transfer'
          ? payment.fulfilment
          : null,
      createdAt: payment.createdAt.toISOString(),
      submissionStartedAt: payment.submissionStartedAt?.toISOString() ?? null,
    };
  }
}

/** Derive funds labels exclusively from the actual matching wallet reservation, never a transport or provider-submission acknowledgement. */
function transferFundsStatus(
  payment: ServicePayment,
): BankTransferResponseDto['fundsStatus'] {
  if (payment.reservationStatus === 'captured') {
    return 'debited';
  }
  if (payment.reservationStatus === 'released') {
    return 'released';
  }
  return payment.reservationId ? 'reserved' : 'not_reserved';
}

/** Project authenticated receiving-bank evidence independently of wallet capture/release completion. */
function transferBankOutcome(
  payment: ServicePayment,
): BankTransferResponseDto['bankOutcome'] {
  if (!payment.outcome) {
    return 'unconfirmed';
  }
  return payment.outcome.outcome === 'succeeded' ? 'credited' : 'failed';
}
