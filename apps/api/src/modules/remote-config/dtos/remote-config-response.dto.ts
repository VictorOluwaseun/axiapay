import { ApiProperty } from '@nestjs/swagger';

/** Advertise independent contact and credential choices; clients require an enabled choice from each. */
export class AuthenticationMethodsConfigurationResponseDto {
  @ApiProperty({ type: Boolean, example: true })
  emailEnabled!: boolean;

  @ApiProperty({ type: Boolean, example: true })
  phoneEnabled!: boolean;

  @ApiProperty({ type: Boolean, example: true })
  passwordEnabled!: boolean;

  @ApiProperty({
    type: Boolean,
    example: true,
    description:
      'Allow passwordless one-time-code authentication. Password signup still requires contact verification.',
  })
  otpEnabled!: boolean;
}

/** Separate signup eligibility from password and one-time-code login eligibility. */
export class AuthenticationConfigurationResponseDto {
  @ApiProperty({ type: AuthenticationMethodsConfigurationResponseDto })
  signup!: AuthenticationMethodsConfigurationResponseDto;

  @ApiProperty({ type: AuthenticationMethodsConfigurationResponseDto })
  login!: AuthenticationMethodsConfigurationResponseDto;
}

/** Feature enablement is separate from adapter readiness and existing payment recovery. */
export class FeatureConfigurationResponseDto {
  @ApiProperty({ type: Boolean, example: true })
  enabled!: boolean;
}

/** Individually configurable payment entry points. */
export class FeaturesConfigurationResponseDto {
  @ApiProperty({ type: FeatureConfigurationResponseDto })
  airtime!: FeatureConfigurationResponseDto;

  @ApiProperty({ type: FeatureConfigurationResponseDto })
  data!: FeatureConfigurationResponseDto;

  @ApiProperty({ type: FeatureConfigurationResponseDto })
  electricity!: FeatureConfigurationResponseDto;

  @ApiProperty({ type: FeatureConfigurationResponseDto })
  tv!: FeatureConfigurationResponseDto;

  @ApiProperty({ type: FeatureConfigurationResponseDto })
  education!: FeatureConfigurationResponseDto;

  @ApiProperty({ type: FeatureConfigurationResponseDto })
  insurance!: FeatureConfigurationResponseDto;

  @ApiProperty({ type: FeatureConfigurationResponseDto })
  bankTransfer!: FeatureConfigurationResponseDto;

  @ApiProperty({ type: FeatureConfigurationResponseDto })
  merchant!: FeatureConfigurationResponseDto;

  @ApiProperty({ type: FeatureConfigurationResponseDto })
  airtimeConversion!: FeatureConfigurationResponseDto;
}

/** Public settings schema deliberately excludes environment variables, credentials and unknown storage keys. */
export class RemoteConfigResponseDto {
  @ApiProperty({
    description:
      'Opaque public configuration version. Send the quoted value in If-None-Match on subsequent requests.',
    example: 'rc1-<sha256>',
    type: String,
  })
  version!: string;

  @ApiProperty({ type: AuthenticationConfigurationResponseDto })
  authentication!: AuthenticationConfigurationResponseDto;

  @ApiProperty({ type: FeaturesConfigurationResponseDto })
  features!: FeaturesConfigurationResponseDto;
}
