import {
  IsUnpaddedText,
  IsReadableText,
} from '../../../shared/validation/input-constraints.js';
import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Accept an explicitly consented installation label and its public SPKI key; ownership comes from the bearer session. */
export class EnrollDeviceDto {
  @ApiProperty({ minLength: 1, maxLength: 80 })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @IsUnpaddedText()
  @IsReadableText()
  readonly deviceName!: string;

  @ApiProperty({
    maxLength: 256,
    description:
      'Unpadded base64url DER SubjectPublicKeyInfo, ECDSA P-256 only.',
  })
  @IsString()
  @MaxLength(256)
  @Matches(/^[A-Za-z0-9_-]+(?![\s\S])/)
  readonly publicKey!: string;
}

/** Address one random server-issued credential ID; identifiers are not credentials by themselves. */
export class DeviceIdentifierDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  @Length(36, 36)
  readonly credentialId!: string;
}

/** Prove possession using the exact server challenge and a bounded ASN.1 DER signature. */
export class DeviceProofDto extends DeviceIdentifierDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  @Length(36, 36)
  readonly challengeId!: string;

  @ApiProperty({
    maxLength: 128,
    description:
      'Unpadded base64url ASN.1 DER SHA256withECDSA signature over decoded message bytes.',
  })
  @IsString()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9_-]+(?![\s\S])/)
  readonly signature!: string;
}

/** Describe a short-lived signing operation; Android must enforce biometric authorization when using the private key. */
export class DeviceChallengeResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly challengeId!: string;
  @ApiProperty({ format: 'uuid' })
  readonly credentialId!: string;
  @ApiProperty({ description: 'Base64url bytes to decode and sign unchanged.' })
  readonly message!: string;
  @ApiProperty({ enum: ['ECDSA_P256_SHA256_DER'] })
  readonly algorithm!: string;
  @ApiProperty({ format: 'date-time' })
  readonly expiresAt!: string;
  @ApiProperty({ example: 120 })
  readonly expiresInSeconds!: number;
}

/** Expose safe owner-visible metadata for active device credentials. */
export class DeviceResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly credentialId!: string;
  @ApiProperty()
  readonly deviceName!: string;
  @ApiProperty({ format: 'date-time' })
  readonly createdAt!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  readonly lastUsedAt!: string | null;
}
