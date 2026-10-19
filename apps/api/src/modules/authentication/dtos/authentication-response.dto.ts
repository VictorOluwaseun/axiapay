import { ApiProperty } from '@nestjs/swagger';
import { ContactDto } from './authentication-request.dto.js';

/** Document public challenge timing without exposing the code or account registration status. */
export class CodeChallengeResponseDto {
  @ApiProperty({ format: 'uuid' }) readonly challengeId!: string;
  @ApiProperty({ format: 'date-time' }) readonly expiresAt!: string;
  @ApiProperty({ type: 'integer', minimum: 0 })
  readonly expiresInSeconds!: number;
  @ApiProperty({ type: 'integer', minimum: 1 })
  readonly resendAfterSeconds!: number;
}

/** Document the verified identity projection; credential and persistence fields are never included. */
export class AccountIdentityResponseDto {
  @ApiProperty({ format: 'uuid' }) readonly id!: string;
  @ApiProperty({ type: () => ContactDto }) readonly contact!: ContactDto;
  @ApiProperty({ format: 'date-time' }) readonly verifiedAt!: string;
}

/** Document the opaque bearer session returned only after successful authentication. */
export class AuthenticationResponseDto {
  @ApiProperty() readonly accessToken!: string;
  @ApiProperty() readonly refreshToken!: string;
  @ApiProperty({ format: 'uuid' }) readonly sessionId!: string;
  @ApiProperty({ enum: ['Bearer'] }) readonly tokenType!: 'Bearer';
  @ApiProperty({ type: 'integer', minimum: 1 })
  readonly expiresInSeconds!: number;
  @ApiProperty({ type: 'integer', minimum: 1 })
  readonly refreshExpiresInSeconds!: number;
  @ApiProperty({ type: () => AccountIdentityResponseDto })
  readonly account!: AccountIdentityResponseDto;
}
