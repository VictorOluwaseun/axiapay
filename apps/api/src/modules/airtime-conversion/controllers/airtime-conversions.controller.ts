import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthenticatedAccount } from '../../authentication/decorators/authenticated-account.decorator.js';
import type { AccountIdentity } from '../../authentication/domain/authentication-models.js';
import { AuthenticationGuard } from '../../authentication/guards/authentication.guard.js';
import { WalletIdParamsDto } from '../../wallets/dtos/wallet-request.dto.js';
import { WalletErrorResponseDto } from '../../wallets/dtos/wallet-response.dto.js';
import {
  AcceptConversionDto,
  ConversionIdDto,
  ConversionOfferResponseDto,
  ConversionQuoteIdDto,
  ConversionQuoteResponseDto,
  ConversionRequestKeyDto,
  ConversionResponseDto,
  CreateConversionQuoteDto,
} from '../dtos/conversion.dto.js';
import { ConversionExceptionFilter } from '../filters/conversion-exception.filter.js';
import { WalletConversionService } from '../services/wallet-conversion.service.js';

/** Session-bound delivery for inbound airtime conversion; customer assertions never serve as receipt or ledger evidence. */
@ApiTags('airtime conversion')
@ApiBearerAuth()
@ApiResponse({ status: 400, type: WalletErrorResponseDto })
@ApiResponse({ status: 401, type: WalletErrorResponseDto })
@ApiResponse({ status: 404, type: WalletErrorResponseDto })
@ApiResponse({ status: 409, type: WalletErrorResponseDto })
@ApiResponse({ status: 422, type: WalletErrorResponseDto })
@ApiResponse({ status: 503, type: WalletErrorResponseDto })
@UseGuards(AuthenticationGuard)
@UseFilters(ConversionExceptionFilter)
@Controller()
export class AirtimeConversionsController {
  /** Delegate financial and recovery workflow rules to the wallet/conversion coordinator. */
  constructor(
    @Inject(WalletConversionService)
    private readonly conversions: WalletConversionService,
  ) {}

  /** Offer discovery authorizes the destination and returns no options until adapters and terms are explicitly configured. */
  @Get('wallets/:walletId/airtime-conversion-offers')
  @Header('Cache-Control', 'no-store')
  @ApiResponse({ status: 200, type: ConversionOfferResponseDto, isArray: true })
  @ApiOperation({
    summary: 'List eligible airtime conversion offers for an owned wallet',
  })
  async offers(
    @Param() params: WalletIdParamsDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<ConversionOfferResponseDto[]> {
    return (
      await this.conversions.listOffers(
        account.id,
        params.walletId.toLowerCase(),
      )
    ).map(ConversionOfferResponseDto.fromOffer);
  }

  /** Check eligibility and produce a fixed price review; no airtime moves or wallet funds are reserved. */
  @Post('airtime-conversions/quotes')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @ApiBody({ type: CreateConversionQuoteDto })
  @ApiResponse({ status: 201, type: ConversionQuoteResponseDto })
  @ApiOperation({
    summary: 'Check airtime eligibility and quote net wallet credit',
  })
  async quote(
    @Body() body: CreateConversionQuoteDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<ConversionQuoteResponseDto> {
    return ConversionQuoteResponseDto.fromQuote(
      await this.conversions.quote({
        actorId: account.id,
        walletId: body.walletId.toLowerCase(),
        offerId: body.offerId,
        sourcePhoneNumber: body.sourcePhoneNumber,
        airtimeMinorUnits: BigInt(body.airtimeMinorUnits),
      }),
    );
  }

  /** Read an owned quote without refreshing its accepted rate or validity. */
  @Get('airtime-conversions/quotes/:quoteId')
  @Header('Cache-Control', 'no-store')
  @ApiResponse({ status: 200, type: ConversionQuoteResponseDto })
  @ApiOperation({ summary: 'Get an owned conversion quote' })
  async getQuote(
    @Param() params: ConversionQuoteIdDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<ConversionQuoteResponseDto> {
    return ConversionQuoteResponseDto.fromQuote(
      await this.conversions.getQuote(account.id, params.quoteId.toLowerCase()),
    );
  }

  /** Explicit consent creates a durable conversion reference before transfer instructions are prepared. */
  @Post('airtime-conversions')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @ApiBody({ type: AcceptConversionDto })
  @ApiResponse({ status: 202, type: ConversionResponseDto })
  @ApiOperation({ summary: 'Accept reviewed airtime conversion terms' })
  async accept(
    @Body() body: AcceptConversionDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<ConversionResponseDto> {
    return ConversionResponseDto.fromRequest(
      await this.conversions.accept(
        account.id,
        body.quoteId.toLowerCase(),
        body.requestKey,
      ),
    );
  }

  /** Recover a lost acceptance response with the same owner-scoped logical key. */
  @Get('airtime-conversions/by-request-key')
  @Header('Cache-Control', 'no-store')
  @ApiResponse({ status: 200, type: ConversionResponseDto })
  @ApiOperation({ summary: 'Find an owned conversion by logical request key' })
  async byKey(
    @Query() query: ConversionRequestKeyDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<ConversionResponseDto> {
    return ConversionResponseDto.fromRequest(
      await this.conversions.findOwnedByKey(account.id, query.requestKey),
    );
  }

  /** Read persistent progress; HTTP reads never initiate external verification or credit. */
  @Get('airtime-conversions/:conversionId')
  @Header('Cache-Control', 'no-store')
  @ApiResponse({ status: 200, type: ConversionResponseDto })
  @ApiOperation({ summary: 'Get an owned airtime conversion' })
  async get(
    @Param() params: ConversionIdDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<ConversionResponseDto> {
    return ConversionResponseDto.fromRequest(
      await this.conversions.getOwned(
        account.id,
        params.conversionId.toLowerCase(),
      ),
    );
  }

  /** Request independent server lookup and durable credit recovery; the transport body cannot contain receipt claims. */
  @Post('airtime-conversions/:conversionId/reconcile')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiBody({
    required: false,
    schema: { type: 'object', additionalProperties: false, properties: {} },
  })
  @ApiResponse({ status: 200, type: ConversionResponseDto })
  @ApiOperation({
    summary: 'Reconcile verified airtime receipt and wallet credit',
  })
  async reconcile(
    @Param() params: ConversionIdDto,
    @Body() body: unknown,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<ConversionResponseDto> {
    assertEmptyReconciliationBody(body);
    return ConversionResponseDto.fromRequest(
      await this.conversions.reconcile(
        account.id,
        params.conversionId.toLowerCase(),
      ),
    );
  }
}

/** This action accepts no input fields; reject asserted success/evidence rather than silently discarding it. */
function assertEmptyReconciliationBody(body: unknown): void {
  if (body === undefined) {
    return;
  }
  if (
    body === null ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length !== 0
  ) {
    throw new BadRequestException();
  }
}
