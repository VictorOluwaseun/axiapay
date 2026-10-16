import { IsUnpaddedText } from '../../../shared/validation/input-constraints.js';
import { Transform } from 'class-transformer';
import {
  ContactValueConstraint,
  canonicalContactValue,
} from '../../authentication/validation/contact-input.js';
import { ApiProperty } from '@nestjs/swagger';
import {
  Validate,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  NotContains,
} from 'class-validator';
import type { FundingOption, FundingRequest } from '../domain/funding.js';

/** Customer funding terms exclude owner identity, settlement evidence, callback URLs, and partner ledger configuration. */
export class CreateFundingRequestDto {
  @ApiProperty({
    example: 'hosted-checkout',
    description:
      'An ID returned by the wallet funding-options endpoint. AxiaPay selects and persists its adapter binding.',
  })
  @IsString()
  @Matches(/^[a-z][a-z0-9-]{0,63}(?![\s\S])/)
  readonly fundingOptionId!: string;

  @ApiProperty({ example: 'NGN', pattern: '^[A-Z]{3}$' })
  @Matches(/^[A-Z]{3}(?![\s\S])/)
  @IsString()
  readonly currency!: string;

  @ApiProperty({
    type: String,
    pattern: '^[1-9][0-9]{0,18}(?![\\s\\S])',
    example: '100000',
  })
  @IsString()
  @Matches(/^[1-9][0-9]{0,18}(?![\s\S])/)
  readonly amountMinorUnits!: string;

  @ApiProperty({
    format: 'email',
    description:
      'Receipt/checkout email; this is never proof of wallet ownership.',
  })
  @Transform(
    ({ value }: { value: unknown }) => canonicalContactValue(value, 'email'),
    { toClassOnly: true },
  )
  @Validate(ContactValueConstraint, ['email'])
  @IsString()
  @MaxLength(254)
  readonly payerEmail!: string;

  @ApiProperty({
    minLength: 1,
    maxLength: 200,
    description:
      'Owner-scoped logical request key; persist before submitting and reuse after uncertainty.',
  })
  @IsString()
  @MaxLength(200)
  @NotContains('\u0000')
  @IsUnpaddedText()
  readonly requestKey!: string;
}

/** Route identity is validated before PostgreSQL access and normalized by the controller. */
export class FundingIdParamsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  readonly fundingId!: string;
}

/** Public funding state; only a committed journal implies credited money, and no provider secrets are serialized. */
export class FundingResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly fundingId!: string;
  @ApiProperty({ format: 'uuid' })
  readonly walletId!: string;
  @ApiProperty({ example: 'hosted-checkout' })
  readonly fundingOptionId!: string;
  @ApiProperty({ enum: ['test', 'live'] })
  readonly environment!: FundingRequest['environment'];
  @ApiProperty({ example: 'NGN' })
  readonly currency!: string;
  @ApiProperty({ type: String, example: '100000' })
  readonly amountMinorUnits!: string;
  @ApiProperty({ enum: ['pending', 'credited'] })
  readonly fundingStatus!: 'pending' | 'credited';
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Hosted checkout URL. Null after uncertain initialization; keep the same request identity and reconcile.',
  })
  readonly checkoutUrl!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  readonly operationId!: string | null;

  /** Derive credit state from the actual ledger receipt, avoiding a second mutable status that can drift after a crash. */
  static fromRequest(request: FundingRequest): FundingResponseDto {
    return {
      fundingId: request.id,
      walletId: request.walletId,
      fundingOptionId: request.fundingOptionId,
      environment: request.environment,
      currency: request.value.currency,
      amountMinorUnits: request.value.amountMinorUnits.toString(),
      fundingStatus: request.operationId ? 'credited' : 'pending',
      checkoutUrl: request.checkoutUrl,
      operationId: request.operationId,
    };
  }
}

/** Public capability discovery; exact limits let clients validate input without knowing any provider protocol. */
export class FundingOptionResponseDto {
  @ApiProperty({ example: 'hosted-checkout' })
  readonly id!: string;
  @ApiProperty({ example: 'Hosted checkout' })
  readonly displayName!: string;
  @ApiProperty({ example: 'NGN' })
  readonly currency!: string;
  @ApiProperty({ type: String, example: '1' })
  readonly minimumAmountMinorUnits!: string;
  @ApiProperty({ type: String, example: '1000000' })
  readonly maximumAmountMinorUnits!: string;

  /** Serialize exact amount limits and omit adapter/ledger identities. */
  static fromOption(option: FundingOption): FundingOptionResponseDto {
    return {
      id: option.id,
      displayName: option.displayName,
      currency: option.currency,
      minimumAmountMinorUnits: option.minimumAmountMinorUnits.toString(),
      maximumAmountMinorUnits: option.maximumAmountMinorUnits.toString(),
    };
  }
}
