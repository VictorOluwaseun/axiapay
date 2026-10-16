import {
  IsReadableText,
  IsUnpaddedText,
} from '../../../shared/validation/input-constraints.js';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsDefined,
  IsISO8601,
  IsObject,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import type { EducationRecipientValidation } from '@axiapay/payments-runtime/modules/payments/domain/education-recipient';
import type {
  InsuredProfile,
  InsuranceApplication,
} from '@axiapay/payments-runtime/modules/payments/domain/insurance-application';
import type {
  InsuredField,
  InsuranceProductTerms,
} from '@axiapay/payments-runtime/modules/service-catalog/domain/insurance-product-terms';

/** Verify the exact institution/product beneficiary identifier without a payment or a caller-supplied verified name. */
export class CreateEducationValidationDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  readonly productId!: string;
  @ApiProperty({ example: '001234567', maxLength: 100 })
  @IsString()
  @Matches(/^[\x20-\x7e]{1,100}(?![\s\S])/)
  @IsUnpaddedText()
  readonly beneficiaryIdentifier!: string;
}

/** Recover owner-scoped preparation evidence, not another customer's beneficiary or insured information. */
export class PreparationIdParamsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  readonly preparationId!: string;
}

/** Customer-facing education verification excludes private evidence and owner identifiers. */
export class EducationValidationResponseDto {
  @ApiProperty({ format: 'uuid' }) readonly id!: string;
  @ApiProperty({ format: 'uuid' }) readonly productId!: string;
  @ApiProperty() readonly institutionCode!: string;
  @ApiProperty({ enum: ['institution_fee', 'voucher'] })
  readonly paymentType!: string;
  @ApiProperty() readonly purpose!: string;
  @ApiProperty() readonly beneficiaryIdentifier!: string;
  @ApiProperty() readonly beneficiaryName!: string;
  @ApiProperty({ format: 'date-time' }) readonly verifiedAt!: string;
  @ApiProperty({ format: 'date-time' }) readonly expiresAt!: string;
  /** Project the owning customer's immutable verified recipient, preserving exact identifiers. */
  static fromValidation(
    validation: EducationRecipientValidation,
  ): EducationValidationResponseDto {
    return {
      id: validation.id,
      productId: validation.productId,
      institutionCode: validation.institutionCode,
      paymentType: validation.paymentType,
      purpose: validation.purpose,
      beneficiaryIdentifier: validation.beneficiaryIdentifier,
      beneficiaryName: validation.beneficiaryName,
      verifiedAt: validation.verifiedAt.toISOString(),
      expiresAt: validation.expiresAt.toISOString(),
    };
  }
}

/** Full reviewable product terms; exclusions, cancellation rules and requested insured fields come from the immutable selected revision. */
export class InsuranceTermsResponseDto implements InsuranceProductTerms {
  @ApiProperty() readonly version!: string;
  @ApiPropertyOptional({
    enum: ['provider_verified', 'submission_requirements'],
  })
  readonly eligibilityMode?: InsuranceProductTerms['eligibilityMode'];
  @ApiPropertyOptional({ enum: ['requested', 'provider_assigned'] })
  readonly coverageStartMode?: InsuranceProductTerms['coverageStartMode'];
  @ApiProperty() readonly coverageSummary!: string;
  @ApiProperty({ type: [String] }) readonly exclusions!: readonly string[];
  @ApiProperty({
    description: 'Requested coverage duration; the end date is exclusive.',
  })
  readonly coverageDurationDays!: number;
  @ApiProperty() readonly cancellationRefundTerms!: string;
  @ApiProperty({
    type: [String],
    enum: [
      'fullName',
      'dateOfBirth',
      'phoneNumber',
      'email',
      'address',
      'identityNumber',
      'assetReference',
      'nextOfKinName',
      'nextOfKinPhoneNumber',
      'occupation',
      'engineCapacityBand',
      'chassisNumber',
      'vehicleMake',
      'vehicleModel',
      'vehicleColour',
      'manufactureYear',
      'state',
      'localGovernmentArea',
    ],
    isArray: true,
  })
  readonly requiredInsuredFields!: readonly InsuredField[];
  @ApiProperty({
    type: [String],
    enum: [
      'fullName',
      'dateOfBirth',
      'phoneNumber',
      'email',
      'address',
      'identityNumber',
      'assetReference',
      'nextOfKinName',
      'nextOfKinPhoneNumber',
      'occupation',
      'engineCapacityBand',
      'chassisNumber',
      'vehicleMake',
      'vehicleModel',
      'vehicleColour',
      'manufactureYear',
      'state',
      'localGovernmentArea',
    ],
    isArray: true,
  })
  readonly optionalInsuredFields!: readonly InsuredField[];
  /** Whitelist reviewed terms so operator storage extensions cannot accidentally expose private adapter configuration. */
  static fromTerms(terms: InsuranceProductTerms): InsuranceTermsResponseDto {
    return {
      version: terms.version,
      eligibilityMode: terms.eligibilityMode,
      coverageStartMode: terms.coverageStartMode,
      coverageSummary: terms.coverageSummary,
      exclusions: terms.exclusions,
      coverageDurationDays: terms.coverageDurationDays,
      cancellationRefundTerms: terms.cancellationRefundTerms,
      requiredInsuredFields: terms.requiredInsuredFields,
      optionalInsuredFields: terms.optionalInsuredFields,
    };
  }
}

/** Whitelist typed insured inputs; product policy further rejects any field it does not request. No implicit primitive conversion is permitted. */
export class InsuredProfileDto {
  @ApiProperty()
  @IsString()
  @Length(1, 200)
  @IsReadableText()
  readonly fullName!: string;
  @ApiPropertyOptional({ format: 'date' })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}(?![\s\S])/)
  @IsISO8601({ strict: true })
  readonly dateOfBirth?: string;
  @ApiPropertyOptional()
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(/^\+[1-9][0-9]{7,14}(?![\s\S])/)
  readonly phoneNumber?: string;
  @ApiPropertyOptional()
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Length(1, 254)
  @Matches(/^[^\s@]+@[^\s@]+\.[^\s@]+(?![\s\S])/)
  @IsReadableText()
  readonly email?: string;
  @ApiPropertyOptional()
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Length(1, 500)
  @IsReadableText()
  readonly address?: string;
  @ApiPropertyOptional()
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Length(1, 100)
  @Matches(/^[\x20-\x7e]{1,100}(?![\s\S])/)
  @IsUnpaddedText()
  readonly identityNumber?: string;
  @ApiPropertyOptional()
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Length(1, 100)
  @Matches(/^[\x20-\x7e]{1,100}(?![\s\S])/)
  @IsUnpaddedText()
  readonly assetReference?: string;
  @ApiPropertyOptional()
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Length(1, 200)
  @IsReadableText()
  readonly nextOfKinName?: string;
  @ApiPropertyOptional()
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(/^\+[1-9][0-9]{7,14}(?![\s\S])/)
  readonly nextOfKinPhoneNumber?: string;
  @ApiPropertyOptional()
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Length(1, 200)
  @IsReadableText()
  readonly occupation?: string;
  @ApiPropertyOptional()
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Length(1, 200)
  @IsReadableText()
  readonly engineCapacityBand?: string;
  @ApiPropertyOptional()
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Length(1, 200)
  @IsReadableText()
  readonly chassisNumber?: string;
  @ApiPropertyOptional()
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Length(1, 200)
  @IsReadableText()
  readonly vehicleMake?: string;
  @ApiPropertyOptional()
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Length(1, 200)
  @IsReadableText()
  readonly vehicleModel?: string;
  @ApiPropertyOptional()
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Length(1, 200)
  @IsReadableText()
  readonly vehicleColour?: string;
  @ApiPropertyOptional()
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(/^(?:19|20)[0-9]{2}(?![\s\S])/)
  readonly manufactureYear?: string;
  @ApiPropertyOptional()
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Length(1, 200)
  @IsReadableText()
  readonly state?: string;
  @ApiPropertyOptional()
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Length(1, 200)
  @IsReadableText()
  readonly localGovernmentArea?: string;
  /** Whitelist the supported effective fields, excluding undeclared storage/adapter extensions. */
  static fromProfile(profile: InsuredProfile): InsuredProfileDto {
    return Object.fromEntries(
      [
        'fullName',
        'dateOfBirth',
        'phoneNumber',
        'email',
        'address',
        'identityNumber',
        'assetReference',
        'nextOfKinName',
        'nextOfKinPhoneNumber',
        'occupation',
        'engineCapacityBand',
        'chassisNumber',
        'vehicleMake',
        'vehicleModel',
        'vehicleColour',
        'manufactureYear',
        'state',
        'localGovernmentArea',
      ]
        .filter((field) => profile[field as keyof InsuredProfile] !== undefined)
        .map((field) => [field, profile[field as keyof InsuredProfile]]),
    ) as unknown as InsuredProfileDto;
  }
}

/** Explicit consent to reviewed fixed-premium terms and insured details; eligibility never buys or issues a policy. */
export class CreateInsuranceApplicationDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  readonly productId!: string;
  @ApiProperty({ type: InsuredProfileDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => InsuredProfileDto)
  readonly insuredProfile!: InsuredProfileDto;
  @ApiProperty() @IsString() @Length(1, 100) readonly termsVersion!: string;
  @ApiProperty({ enum: [true] })
  @IsBoolean()
  @Equals(true)
  readonly acceptedTerms!: boolean;
  @ApiProperty({ format: 'date' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}(?![\s\S])/)
  @IsISO8601({ strict: true })
  readonly coverageStartsOn!: string;
}

/** Owner-scoped consented eligibility snapshot; payment and issuance remain separate observable states. */
export class InsuranceApplicationResponseDto {
  @ApiProperty({ format: 'uuid' }) readonly id!: string;
  @ApiProperty({ format: 'uuid' }) readonly productId!: string;
  @ApiProperty({ type: InsuredProfileDto })
  readonly insuredProfile!: InsuredProfileDto;
  @ApiProperty() readonly termsVersion!: string;
  @ApiProperty({ enum: [true] }) readonly acceptedTerms!: true;
  @ApiProperty({
    enum: ['eligible', 'submission_ready'],
    description:
      'Submission readiness confirms protocol requirements only, without insurer underwriting approval.',
  })
  readonly eligibilityStatus!: 'eligible' | 'submission_ready';
  @ApiProperty({ enum: ['provider_verified', 'submission_requirements'] })
  readonly eligibilityMode!: 'provider_verified' | 'submission_requirements';
  @ApiProperty({ enum: ['requested', 'provider_assigned'] })
  readonly coverageStartMode!: 'requested' | 'provider_assigned';
  @ApiProperty({ format: 'date' }) readonly coverageStartsOn!: string;
  @ApiProperty({
    format: 'date',
    description:
      'Exclusive end of the requested coverage period; actual issuance must still be confirmed.',
  })
  readonly coverageEndsOn!: string;
  @ApiProperty({ format: 'date-time' }) readonly createdAt!: string;
  @ApiProperty({ format: 'date-time' }) readonly expiresAt!: string;
  /** Project consent and eligibility without exposing private evidence or claiming issued/active insurance. */
  static fromApplication(
    application: InsuranceApplication,
  ): InsuranceApplicationResponseDto {
    return {
      id: application.id,
      productId: application.productId,
      insuredProfile: InsuredProfileDto.fromProfile(application.insuredProfile),
      termsVersion: application.termsVersion,
      acceptedTerms: true,
      eligibilityStatus:
        application.eligibilityMode === 'submission_requirements'
          ? 'submission_ready'
          : 'eligible',
      eligibilityMode: application.eligibilityMode ?? 'provider_verified',
      coverageStartMode: application.coverageStartMode ?? 'requested',
      coverageStartsOn: application.coverageStartsOn,
      coverageEndsOn: application.coverageEndsOn,
      createdAt: application.createdAt.toISOString(),
      expiresAt: application.expiresAt.toISOString(),
    };
  }
}
