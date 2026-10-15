import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  NotContains,
} from 'class-validator';

/** Provision an empty wallet for the session owner; currency availability is a separate product policy. */
export class CreateWalletDto {
  @ApiProperty({ pattern: '^[A-Z]{3}$', example: 'NGN' })
  @IsString()
  @Length(3, 3)
  @Matches(/^[A-Z]{3}$/)
  readonly currency!: string;
}

/** Validate route identity before storage access; the controller canonicalizes UUID case. */
export class WalletIdParamsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  @Length(36, 36)
  readonly walletId!: string;
}

/** Submit one internal transfer; identity and source wallet come from the session and route respectively. */
export class TransferWalletFundsDto extends CreateWalletDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  @Length(36, 36)
  readonly destinationWalletId!: string;

  @ApiProperty({
    type: String,
    pattern: '^[1-9][0-9]{0,18}(?![\\s\\S])',
    example: '12500',
    description:
      'Exact positive minor units, at most 9223372036854775807. JSON numbers are rejected.',
  })
  @IsString()
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
  @IsString()
  @MaxLength(200)
  // PostgreSQL text cannot store NUL; reject it as input instead of a dependency failure.
  @NotContains('\u0000')
  @Matches(/^\S(?:[\s\S]*\S)?(?![\s\S])/)
  readonly requestKey!: string;
}
