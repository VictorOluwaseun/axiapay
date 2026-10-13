import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsObject,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import type { Contact } from '../domain/authentication-models.js';

/** Describe contact input; canonicalization and channel-specific identity rules remain in the domain. */
export class ContactDto implements Contact {
  @ApiProperty({ enum: ['email', 'phone'], example: 'email' })
  @IsIn(['email', 'phone'])
  readonly kind!: Contact['kind'];

  @ApiProperty({ minLength: 1, maxLength: 254, example: 'alice@example.com' })
  @IsString()
  @MinLength(1)
  @MaxLength(254)
  readonly value!: string;
}

/** Accept exactly one contact for code delivery; callers cannot choose account IDs or code purposes. */
export class RequestLoginCodeDto {
  @ApiProperty({ type: () => ContactDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => ContactDto)
  readonly contact!: ContactDto;
}

/** Allow omission of a signup password, but reject null and non-string credentials before hashing. */
export class SignupDto extends RequestLoginCodeDto {
  @ApiPropertyOptional({
    minLength: 15,
    maxLength: 128,
    description:
      'Optional passphrase; omit for code-only signup. Whitespace is preserved.',
  })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsString()
  @MaxLength(256)
  readonly password?: string;
}

/** Bound password-login input without trimming, case folding, or implicit conversion. */
export class PasswordLoginDto extends RequestLoginCodeDto {
  @ApiProperty({ minLength: 1, maxLength: 256 })
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  readonly password!: string;
}

/** Bind the six-digit string to a server-issued challenge; leading zeros must survive validation. */
export class VerifyCodeDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  readonly challengeId!: string;

  @ApiProperty({ pattern: '^\\d{6}$', example: '012345' })
  @IsString()
  @Matches(/^\d{6}$/)
  readonly code!: string;
}
