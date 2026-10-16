import { ApiProperty } from '@nestjs/swagger';
import { IsUnpaddedText } from '../../../shared/validation/input-constraints.js';
import { IsUUID, Matches, MaxLength, NotContains } from 'class-validator';

/** Provision an empty wallet for the session owner; currency availability is a separate product policy. */
export class CreateWalletDto {
  @ApiProperty({ pattern: '^[A-Z]{3}$', example: 'NGN' })
  @Matches(/^[A-Z]{3}(?![\s\S])/)
  readonly currency!: string;
}

/** Select the authenticated account's existing wallet using the same strict currency contract as creation. */
export class CurrentWalletQueryDto extends CreateWalletDto {}

/** Validate route identity before storage access; the controller canonicalizes UUID case. */
export class WalletIdParamsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  readonly walletId!: string;
}

/** Submit one internal transfer; identity and source wallet come from the session and route respectively. */
export class TransferWalletFundsDto extends CreateWalletDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  readonly destinationWalletId!: string;

  @ApiProperty({
    type: String,
    pattern: '^[1-9][0-9]{0,18}(?![\\s\\S])',
    example: '12500',
    description:
      'Exact positive minor units, at most 9223372036854775807. JSON numbers are rejected.',
  })
  // Absolute end-of-input rejects trailing newlines that JavaScript's $ anchor permits.
  @Matches(/^[1-9][0-9]{0,18}(?![\s\S])/)
  readonly amountMinorUnits!: string;

  @ApiProperty({
    minLength: 1,
    maxLength: 200,
    example: 'transfer-0192d5ca-7c24-7f32-9c93-c755ff393782',
    description:
      'Owner-scoped logical request identity. Persist before submission and reuse with identical terms after a timeout.',
  })
  @MaxLength(200)
  // PostgreSQL text cannot store NUL; reject it as input instead of a dependency failure.
  @NotContains('\u0000')
  @IsUnpaddedText()
  readonly requestKey!: string;
}
