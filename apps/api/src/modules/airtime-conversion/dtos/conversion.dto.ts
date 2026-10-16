import { IsUnpaddedText } from '../../../shared/validation/input-constraints.js';
import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  NotContains,
} from 'class-validator';
import {
  conversionStatus,
  type ConversionOffer,
  type ConversionQuote,
  type ConversionRequest,
} from '../domain/conversion.js';

/** Eligibility and price request; identity, currency, rates, fees, destinations and evidence are server-owned. */
export class CreateConversionQuoteDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  readonly walletId!: string;
  @ApiProperty({ example: 'eligible-network-airtime' })
  @IsString()
  @Matches(/^[a-z][a-z0-9-]{0,63}(?![\s\S])/)
  readonly offerId!: string;
  @ApiProperty({ example: '+2348012345678' })
  @IsString()
  @Matches(/^\+[1-9][0-9]{7,14}(?![\s\S])/)
  readonly sourcePhoneNumber!: string;
  @ApiProperty({
    type: String,
    example: '100000',
    description:
      'Airtime face value in the wallet currency minor units; exact positive integer, bounded by the offer and SQL bigint.',
  })
  @IsString()
  @Matches(/^[1-9][0-9]{0,18}(?![\s\S])/)
  readonly airtimeMinorUnits!: string;
}

/** Owner-scoped logical acceptance identity; persist before submission and reuse after response loss. */
export class ConversionRequestKeyDto {
  @ApiProperty({ maxLength: 200, minLength: 1 })
  @IsString()
  @MaxLength(200)
  @NotContains('\u0000')
  @IsUnpaddedText()
  readonly requestKey!: string;
}

/** Explicit consent to one immutable reviewed quote; no amount or provider evidence override is accepted. */
export class AcceptConversionDto extends ConversionRequestKeyDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  readonly quoteId!: string;
}

/** Quote route identity is normalized by delivery after UUID validation. */
export class ConversionQuoteIdDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  readonly quoteId!: string;
}

/** Owner-scoped conversion route identity. */
export class ConversionIdDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  readonly conversionId!: string;
}

/** Disclosed, exact offer arithmetic and limits; no upstream product or clearing-account identities are exposed. */
export class ConversionOfferResponseDto {
  @ApiProperty() readonly offerId!: string;
  @ApiProperty() readonly displayName!: string;
  @ApiProperty() readonly networkCode!: string;
  @ApiProperty() readonly currency!: string;
  @ApiProperty() readonly termsVersion!: string;
  @ApiProperty({ type: String }) readonly rateNumerator!: string;
  @ApiProperty({ type: String }) readonly rateDenominator!: string;
  @ApiProperty({ enum: ['airtime_face_value_minor_units'] })
  readonly calculationBasis!: 'airtime_face_value_minor_units';
  @ApiProperty({ enum: ['floor'] }) readonly grossCreditRounding!: 'floor';
  @ApiProperty({ enum: ['ceil'] }) readonly proportionalFeeRounding!: 'ceil';
  @ApiProperty({ type: String }) readonly fixedFeeMinorUnits!: string;
  @ApiProperty({
    type: Number,
    description:
      'Proportional fee on rounded gross credit, in hundredths of a percent.',
  })
  readonly feeBasisPoints!: number;
  @ApiProperty({ type: String }) readonly minimumAirtimeMinorUnits!: string;
  @ApiProperty({ type: String }) readonly maximumAirtimeMinorUnits!: string;
  @ApiProperty({ type: String }) readonly airtimeStepMinorUnits!: string;
  @ApiProperty({ type: Number }) readonly quoteValiditySeconds!: number;
  @ApiProperty({ type: Number }) readonly transferWindowSeconds!: number;

  /** Map only first-party terms, serializing every monetary/rational integer without floating point. */
  static fromOffer(offer: ConversionOffer): ConversionOfferResponseDto {
    return {
      offerId: offer.id,
      displayName: offer.displayName,
      networkCode: offer.networkCode,
      currency: offer.currency,
      termsVersion: offer.termsVersion,
      rateNumerator: offer.rateNumerator.toString(),
      rateDenominator: offer.rateDenominator.toString(),
      calculationBasis: 'airtime_face_value_minor_units',
      grossCreditRounding: 'floor',
      proportionalFeeRounding: 'ceil',
      fixedFeeMinorUnits: offer.fixedFeeMinorUnits.toString(),
      feeBasisPoints: offer.feeBasisPoints,
      minimumAirtimeMinorUnits: offer.minimumAirtimeMinorUnits.toString(),
      maximumAirtimeMinorUnits: offer.maximumAirtimeMinorUnits.toString(),
      airtimeStepMinorUnits: offer.airtimeStepMinorUnits.toString(),
      quoteValiditySeconds: offer.quoteValiditySeconds,
      transferWindowSeconds: offer.transferWindowSeconds,
    };
  }
}

/** Immutable customer review including source, face value, fees, expected net proceeds and acceptance deadline. */
export class ConversionQuoteResponseDto {
  @ApiProperty({ format: 'uuid' }) readonly quoteId!: string;
  @ApiProperty({ format: 'uuid' }) readonly walletId!: string;
  @ApiProperty() readonly sourcePhoneNumber!: string;
  @ApiProperty({ type: ConversionOfferResponseDto })
  readonly offer!: ConversionOfferResponseDto;
  @ApiProperty({ type: String }) readonly airtimeMinorUnits!: string;
  @ApiProperty({ type: String }) readonly grossCreditMinorUnits!: string;
  @ApiProperty({ type: String }) readonly feeMinorUnits!: string;
  @ApiProperty({ type: String }) readonly netCreditMinorUnits!: string;
  @ApiProperty({ format: 'date-time' }) readonly quotedAt!: string;
  @ApiProperty({ format: 'date-time' }) readonly expiresAt!: string;

  /** Quote validity is observable, while accepted conversions retain the same arithmetic after expiry. */
  static fromQuote(quote: ConversionQuote): ConversionQuoteResponseDto {
    return {
      quoteId: quote.id,
      walletId: quote.walletId,
      sourcePhoneNumber: quote.sourcePhoneNumber,
      offer: ConversionOfferResponseDto.fromOffer(quote.offer),
      airtimeMinorUnits: quote.airtimeValue.amountMinorUnits.toString(),
      grossCreditMinorUnits: quote.grossCreditValue.amountMinorUnits.toString(),
      feeMinorUnits: quote.feeMinorUnits.toString(),
      netCreditMinorUnits: quote.netCreditValue.amountMinorUnits.toString(),
      quotedAt: quote.quotedAt.toISOString(),
      expiresAt: quote.expiresAt.toISOString(),
    };
  }
}

/** Instructions bind the accepted source and face value to a fixed receiving number and deadline; they never imply payment success. */
export class ConversionInstructionsResponseDto {
  @ApiProperty() readonly instructionReference!: string;
  @ApiProperty() readonly receivingPhoneNumber!: string;
  @ApiProperty() readonly description!: string;
  @ApiProperty({ format: 'date-time' }) readonly issuedAt!: string;
}

/** Public conversion progress; ledger credit is independent of airtime verification and exceptions require support. */
export class ConversionResponseDto {
  @ApiProperty({ format: 'uuid' }) readonly conversionId!: string;
  @ApiProperty() readonly requestKey!: string;
  @ApiProperty({ type: ConversionQuoteResponseDto })
  readonly quote!: ConversionQuoteResponseDto;
  @ApiProperty({
    enum: [
      'preparing',
      'awaiting_receipt',
      'verification_pending',
      'credit_pending',
      'credited',
      'exception',
    ],
  })
  readonly conversionStatus!: ReturnType<typeof conversionStatus>;
  @ApiProperty({ format: 'date-time' }) readonly acceptedAt!: string;
  @ApiProperty({ format: 'date-time' }) readonly receiveBy!: string;
  @ApiProperty({ type: ConversionInstructionsResponseDto, nullable: true })
  readonly instructions!: ConversionInstructionsResponseDto | null;
  @ApiProperty({
    type: String,
    nullable: true,
    enum: [
      'amount_mismatch',
      'late_receipt',
      'terms_mismatch',
      'verification_failed',
      'movement_conflict',
    ],
  })
  readonly exceptionCode!: string | null;
  @ApiProperty({
    enum: [
      'follow_transfer_instructions',
      'reconcile_original_conversion',
      'contact_support',
      'none',
    ],
  })
  readonly nextAction!:
    | 'follow_transfer_instructions'
    | 'reconcile_original_conversion'
    | 'contact_support'
    | 'none';
  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  readonly operationId!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  readonly receivedAt!: string | null;
  @ApiProperty({ type: String, nullable: true })
  readonly observedAirtimeMinorUnits!: string | null;
  @ApiProperty({ type: String, nullable: true }) readonly observedCurrency!:
    string | null;

  /** Derive status and next action from append-only evidence plus a committed journal; no economic provider identifiers escape. */
  static fromRequest(request: ConversionRequest): ConversionResponseDto {
    const status = conversionStatus(request);
    const nextActions = {
      preparing: 'reconcile_original_conversion',
      awaiting_receipt: 'follow_transfer_instructions',
      verification_pending: 'reconcile_original_conversion',
      credit_pending: 'reconcile_original_conversion',
      credited: 'none',
      exception: 'contact_support',
    } as const;
    return {
      conversionId: request.id,
      requestKey: request.requestKey,
      quote: ConversionQuoteResponseDto.fromQuote(request.quote),
      conversionStatus: status,
      acceptedAt: request.acceptedAt.toISOString(),
      receiveBy: request.receiveBy.toISOString(),
      instructions: request.instructions
        ? {
            instructionReference: request.instructions.instructionReference,
            receivingPhoneNumber: request.instructions.receivingPhoneNumber,
            description: request.instructions.description,
            issuedAt: request.instructions.issuedAt.toISOString(),
          }
        : null,
      exceptionCode: request.hasPostingConflict
        ? 'movement_conflict'
        : (request.outcome?.exceptionCode ?? null),
      nextAction: nextActions[status],
      operationId: request.operationId,
      receivedAt: request.outcome?.receivedAt?.toISOString() ?? null,
      observedAirtimeMinorUnits:
        request.outcome?.observedAirtimeValue?.amountMinorUnits.toString() ??
        null,
      observedCurrency: request.outcome?.observedAirtimeValue?.currency ?? null,
    };
  }
}
