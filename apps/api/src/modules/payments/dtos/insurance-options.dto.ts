import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsString,
  Length,
  Validate,
  ValidateIf,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
  type ValidationArguments,
} from 'class-validator';
import { IsReadableText } from '../../../shared/validation/input-constraints.js';
import type {
  InsuranceInputOption,
  InsuranceOptionField,
} from '@axiapay/payments-runtime/modules/payments/ports/insurance-input-options';

/** Static dependency shape belongs at the boundary, before any current-product or provider lookup. */
@ValidatorConstraint({ name: 'insuranceOptionParent', async: false })
class InsuranceOptionParent implements ValidatorConstraintInterface {
  /** Require a parent exactly for model/LGA selection, rejecting ignored parent inputs on other fields. */
  validate(value: unknown, arguments_: ValidationArguments): boolean {
    const field = (arguments_.object as { field?: unknown }).field;
    return field === 'vehicleModel' || field === 'localGovernmentArea'
      ? value !== undefined
      : value === undefined;
  }
}

/** Bounded first-party option query; customer inputs can never supply provider codes, paths or URLs. */
export class InsuranceOptionsQueryDto {
  @ApiProperty({
    enum: [
      'engineCapacityBand',
      'vehicleMake',
      'vehicleModel',
      'vehicleColour',
      'state',
      'localGovernmentArea',
    ],
  })
  @IsIn([
    'engineCapacityBand',
    'vehicleMake',
    'vehicleModel',
    'vehicleColour',
    'state',
    'localGovernmentArea',
  ])
  readonly field!: InsuranceOptionField;
  @ApiPropertyOptional({
    description:
      'Selected make for a model, or selected state for a local area.',
  })
  @Validate(InsuranceOptionParent)
  @ValidateIf(
    (object, value) =>
      value !== undefined ||
      ['vehicleModel', 'localGovernmentArea'].includes(object.field),
  )
  @IsString()
  @Length(1, 200)
  @IsReadableText()
  readonly parentValue?: string;
}

/** Public option projections contain meaningful values and labels only. */
export class InsuranceInputOptionResponseDto implements InsuranceInputOption {
  @ApiProperty() readonly value!: string;
  @ApiProperty() readonly label!: string;
}

/** Current product-specific options, with no claim of underwriting or purchase authorization. */
export class InsuranceOptionsResponseDto {
  @ApiProperty({
    enum: [
      'engineCapacityBand',
      'vehicleMake',
      'vehicleModel',
      'vehicleColour',
      'state',
      'localGovernmentArea',
    ],
  })
  readonly field!: InsuranceOptionField;
  @ApiProperty({ type: [InsuranceInputOptionResponseDto] })
  readonly options!: readonly InsuranceInputOptionResponseDto[];
}
