import { authenticationPolicy } from '../domain/authentication-policy.js';
import {
  ContactValueConstraint,
  canonicalContactValue,
} from '../validation/contact-input.js';
import { IsCodePointLength } from '../../../shared/validation/input-constraints.js';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsObject,
  IsString,
  IsUUID,
  Validate,
  Length,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import type { Contact } from '../domain/authentication-models.js';

/** Validate and canonicalize contact input at the pipe boundary; services receive a consistent identity. */
export class ContactDto implements Contact {
  @ApiProperty({ enum: ['email', 'phone'], example: 'email' })
  @IsIn(['email', 'phone'])
  readonly kind!: Contact['kind'];

  @ApiProperty({ minLength: 1, maxLength: 254, example: 'alice@example.com' })
  @Transform(
    ({ value, obj }: { value: unknown; obj: { kind?: unknown } }) =>
      canonicalContactValue(value, obj.kind),
    { toClassOnly: true },
  )
  @Validate(ContactValueConstraint)
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
    minLength: authenticationPolicy.newPasswordMinCodePoints,
    maxLength: authenticationPolicy.passwordMaxCodePoints,
    description:
      'Optional passphrase; omit for code-only signup. Whitespace is preserved.',
  })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsString()
  @IsCodePointLength(
    authenticationPolicy.newPasswordMinCodePoints,
    authenticationPolicy.passwordMaxCodePoints,
  )
  readonly password?: string;
}

/** Bound password-login input without trimming, case folding, or implicit conversion. */
export class PasswordLoginDto extends RequestLoginCodeDto {
  @ApiProperty({
    minLength: 1,
    maxLength: authenticationPolicy.passwordMaxCodePoints,
  })
  @IsString()
  @IsCodePointLength(1, authenticationPolicy.passwordMaxCodePoints)
  readonly password!: string;
}

/** Bind the six-digit string to a server-issued challenge; leading zeros must survive validation. */
export class VerifyCodeDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  @Length(36, 36)
  readonly challengeId!: string;

  @ApiProperty({ pattern: '^\\d{6}$', example: '012345' })
  @IsString()
  @Matches(/^\d{6}(?![\s\S])/)
  readonly code!: string;
}

/** Validate an opaque credential for a non-HTTP authentication adapter; HTTP uses the existing bearer-header reader. */
export class SessionTokenInputDto {
  @ApiProperty({ pattern: '^[A-Za-z0-9_-]{43}$' })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}(?![\s\S])/)
  readonly token!: string;
}

/** Request recovery for one canonical contact; purpose and account identity remain server-owned. */
export class RequestPasswordResetDto extends RequestLoginCodeDto {}

/** Submit proof and a new passphrase together; a valid reset never creates a bearer session. */
export class ResetPasswordDto extends VerifyCodeDto {
  @ApiProperty({
    minLength: authenticationPolicy.newPasswordMinCodePoints,
    maxLength: authenticationPolicy.passwordMaxCodePoints,
    description: 'New passphrase; whitespace is preserved.',
  })
  @IsString()
  @IsCodePointLength(
    authenticationPolicy.newPasswordMinCodePoints,
    authenticationPolicy.passwordMaxCodePoints,
  )
  readonly newPassword!: string;
}
