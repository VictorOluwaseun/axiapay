import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, Length, Matches } from 'class-validator';
import type { BillAccountValidation } from '@axiapay/backend/modules/payments/domain/bill-account';

/** Non-financial account verification request; product identifies the biller/package or prepaid/postpaid mode. */
export class CreateBillAccountValidationDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  @Length(36, 36)
  readonly productId!: string;

  @ApiProperty({
    minLength: 1,
    maxLength: 100,
    example: '00123456789',
    description:
      'Exact customer/decoder/meter identifier. Leading zeros are preserved; no implicit number conversion or trimming.',
  })
  @IsString()
  @Matches(/^[\x20-\x7e]{1,100}(?![\s\S])/)
  @Matches(/^\S(?:[\s\S]*\S)?(?![\s\S])/)
  readonly accountNumber!: string;
}

/** Owner-scoped validation identifier; customer details cannot be recovered by guessing another owner's UUID. */
export class BillAccountValidationIdParamsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  @Length(36, 36)
  readonly validationId!: string;
}

/** Verified customer-facing recipient snapshot, excluding owner IDs, adapter keys and private evidence. */
export class BillAccountValidationResponseDto {
  @ApiProperty({ format: 'uuid' }) readonly id!: string;
  @ApiProperty({ format: 'uuid' }) readonly productId!: string;
  @ApiProperty({ enum: ['tv', 'electricity'] }) readonly serviceType!: string;
  @ApiProperty() readonly billerCode!: string;
  @ApiProperty({ type: String, enum: ['prepaid', 'postpaid'], nullable: true })
  readonly electricityMeterType!: string | null;
  @ApiProperty() readonly accountNumber!: string;
  @ApiProperty() readonly customerName!: string;
  @ApiProperty({ type: String, nullable: true }) readonly serviceAddress!:
    string | null;
  @ApiProperty({ format: 'date-time' }) readonly verifiedAt!: string;
  @ApiProperty({ format: 'date-time' }) readonly expiresAt!: string;

  /** Project authenticated account details for the owning customer without exposing the provider-verification evidence. */
  static fromValidation(
    validation: BillAccountValidation,
  ): BillAccountValidationResponseDto {
    return {
      id: validation.id,
      productId: validation.productId,
      serviceType: validation.serviceType,
      billerCode: validation.billerCode,
      electricityMeterType: validation.electricityMeterType,
      accountNumber: validation.accountNumber,
      customerName: validation.customerName,
      serviceAddress: validation.serviceAddress,
      verifiedAt: validation.verifiedAt.toISOString(),
      expiresAt: validation.expiresAt.toISOString(),
    };
  }
}
