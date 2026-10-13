import { ApiProperty } from '@nestjs/swagger';

/** Authenticated TV activation evidence; renewal time is optional and never estimated from the payment time. */
export class TvFulfilmentResponseDto {
  @ApiProperty({ enum: ['tv_subscription'] })
  readonly fulfilmentType!: 'tv_subscription';
  @ApiProperty() readonly activationReference!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readonly renewalAt!: string | null;
}

/** Ordered printable electricity token; labels distinguish recharge and any required meter key-change tokens. */
export class ElectricityTokenResponseDto {
  @ApiProperty() readonly label!: string;
  @ApiProperty() readonly value!: string;
}

/** Prepaid fulfilment details from the original payment; absent tokens remain pending rather than prompting another purchase. */
export class PrepaidElectricityFulfilmentResponseDto {
  @ApiProperty({ enum: ['electricity_prepaid'] })
  readonly fulfilmentType!: 'electricity_prepaid';
  @ApiProperty() readonly receiptReference!: string;
  @ApiProperty({
    type: [ElectricityTokenResponseDto],
    minItems: 1,
    maxItems: 8,
  })
  readonly tokens!: ElectricityTokenResponseDto[];
  @ApiProperty({
    type: String,
    nullable: true,
    example: '12.375',
    description:
      'Exact provider-confirmed kWh decimal string; no binary floating-point conversion.',
  })
  readonly unitsKilowattHours!: string | null;
}

/** Postpaid payment evidence has a receipt reference and no prepaid token. */
export class PostpaidElectricityFulfilmentResponseDto {
  @ApiProperty({ enum: ['electricity_postpaid'] })
  readonly fulfilmentType!: 'electricity_postpaid';
  @ApiProperty() readonly receiptReference!: string;
}

/** Confirmed institution fee reference from the original payment. */
export class EducationFeeFulfilmentResponseDto {
  @ApiProperty({ enum: ['education_fee'] })
  readonly fulfilmentType!: 'education_fee';
  @ApiProperty() readonly institutionReference!: string;
}

/** Issued education voucher; codes and serial numbers remain exact strings, including leading zeros. */
export class EducationVoucherFulfilmentResponseDto {
  @ApiProperty({ enum: ['education_voucher'] })
  readonly fulfilmentType!: 'education_voucher';
  @ApiProperty() readonly voucherCode!: string;
  @ApiProperty({ type: String, nullable: true }) readonly serialNumber!:
    string | null;
}

/** Authenticated issuance evidence, distinct from payment and any assertion that coverage is currently active. */
export class InsurancePolicyFulfilmentResponseDto {
  @ApiProperty({ enum: ['insurance_policy'] })
  readonly fulfilmentType!: 'insurance_policy';
  @ApiProperty() readonly policyNumber!: string;
  @ApiProperty() readonly insuredName!: string;
  @ApiProperty({ format: 'date' }) readonly coverageStartsOn!: string;
  @ApiProperty({
    format: 'date',
    description: 'Exclusive confirmed policy end.',
  })
  readonly coverageEndsOn!: string;
}
