import {
  IsReadableText,
  HasExactlyOneField,
} from '../../../shared/validation/input-constraints.js';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ServiceType } from '../../service-catalog/domain/service-product.js';
import {
  IsIn,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  NotContains,
  ValidateIf,
} from 'class-validator';

/** Request immutable server pricing for a selected product and wallet; caller identity comes only from the authenticated session. */
export class CreatePaymentQuoteDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  @Length(36, 36)
  readonly walletId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  @Length(36, 36)
  @HasExactlyOneField([
    'recipientPhoneNumber',
    'accountValidationId',
    'bankBeneficiaryValidationId',
    'educationValidationId',
    'insuranceApplicationId',
  ])
  readonly productId!: string;

  @ApiPropertyOptional({
    example: '+2348012345678',
    description:
      'Explicit international recipient. The selected product determines the network; phone prefixes do not.',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(/^\+[1-9][0-9]{7,14}(?![\s\S])/)
  readonly recipientPhoneNumber?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Required for TV/electricity and forbidden for mobile products. Server-owned validated account and selected product must match.',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  @Length(36, 36)
  readonly accountValidationId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Required only for bank transfers; server-owned verified receiving bank/account snapshot.',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  @Length(36, 36)
  readonly bankBeneficiaryValidationId?: string;

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 140,
    description:
      'Optional only for bank transfers; preserved in reviewed terms.',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Length(1, 140)
  @IsReadableText()
  readonly narration?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Required only for education; binds the verified beneficiary to this selected product.',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  @Length(36, 36)
  readonly educationValidationId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Required only for insurance; binds consented eligible insured details and the requested period.',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  @Length(36, 36)
  readonly insuranceApplicationId?: string;

  @ApiPropertyOptional({
    type: String,
    example: '10000',
    description:
      'Exact positive minor units, at most 9223372036854775807. Required for variable-price products; forbidden for fixed-price products including insurance and vouchers.',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(/^[1-9][0-9]{0,18}(?![\s\S])/)
  readonly amountMinorUnits?: string;
}

/** Owner-scoped logical identity for submission or recovery; transport channels must reuse the same persisted key. */
export class PaymentRequestIdentityDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 200,
    description:
      'Persist this logical identity and reuse it with the same quote after uncertainty; use the same identity across online and future SMS transport.',
  })
  @IsString()
  @MaxLength(200)
  @NotContains('\u0000')
  @Matches(/^\S(?:[\s\S]*\S)?(?![\s\S])/)
  readonly requestKey!: string;
}

/** Explicit consent to a previously reviewed quote; no price, fee, recipient, provider, or owner override is accepted. */
export class SubmitServicePaymentDto extends PaymentRequestIdentityDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  @Length(36, 36)
  readonly quoteId!: string;
}

/** Canonical payment route identifier; adapters normalize accepted UUID case before calling services. */
export class PaymentIdParamsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  @Length(36, 36)
  readonly paymentId!: string;
}

/** Owner-scoped quote route identifier. */
export class QuoteIdParamsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  @Length(36, 36)
  readonly quoteId!: string;
}

/** Bounded catalogue filters, kept as explicit query strings rather than implicit primitive conversions. */
export class ProductQueryDto {
  @ApiPropertyOptional({
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
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn([
    'airtime',
    'data',
    'tv',
    'electricity',
    'education',
    'insurance',
    'bank_transfer',
  ])
  readonly serviceType?: ServiceType;

  @ApiPropertyOptional({
    description: 'First-party biller code for TV/electricity.',
    maxLength: 50,
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{0,49}(?![\s\S])/)
  readonly billerCode?: string;

  @ApiPropertyOptional({ enum: ['prepaid', 'postpaid'] })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['prepaid', 'postpaid'])
  readonly electricityMeterType?: 'prepaid' | 'postpaid';

  @ApiPropertyOptional({ example: 'mtn', maxLength: 50 })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{0,49}(?![\s\S])/)
  readonly networkCode?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  @Length(36, 36)
  readonly bankId?: string;
  @ApiPropertyOptional({ example: 'NGN' })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(/^[A-Z]{3}(?![\s\S])/)
  readonly currency?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Cursor from the previous page with the same filters.',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  @Length(36, 36)
  readonly afterId?: string;

  @ApiPropertyOptional({
    type: String,
    default: '50',
    description: 'Page size, from 1 to 100.',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(/^(?:[1-9][0-9]?|100)(?![\s\S])/)
  readonly limit?: string;
}

/** Selected product revision identifier, never an upstream provider SKU. */
export class ProductIdParamsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  @Length(36, 36)
  readonly productId!: string;
}
