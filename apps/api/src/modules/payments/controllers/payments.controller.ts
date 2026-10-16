import {
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
import { WalletPaymentService } from '@axiapay/payments-runtime/modules/payments/services/wallet-payment.service';
import { PaymentQuoteService } from '@axiapay/payments-runtime/modules/payments/services/payment-quote.service';
import {
  CreatePaymentQuoteDto,
  PaymentIdParamsDto,
  PaymentRequestIdentityDto,
  QuoteIdParamsDto,
  SubmitServicePaymentDto,
} from '../dtos/payment-request.dto.js';
import {
  PaymentErrorResponseDto,
  PaymentQuoteResponseDto,
  PaymentReviewResponseDto,
  ServicePaymentResponseDto,
} from '../dtos/payment-response.dto.js';
import { PaymentExceptionFilter } from '../filters/payment-exception.filter.js';

/** Bind first-party service payment requests to the authenticated account; pricing, holds and recovery belong to feature services. */
@ApiTags('payments')
@ApiBearerAuth()
@ApiResponse({ status: 400, type: PaymentErrorResponseDto })
@ApiResponse({ status: 401, type: PaymentErrorResponseDto })
@ApiResponse({ status: 404, type: PaymentErrorResponseDto })
@ApiResponse({ status: 409, type: PaymentErrorResponseDto })
@ApiResponse({ status: 503, type: PaymentErrorResponseDto })
@UseGuards(AuthenticationGuard)
@UseFilters(PaymentExceptionFilter)
@Controller('payments')
export class PaymentsController {
  /** Keep transport mapping separate from review, financial authorization and external fulfilment. */
  constructor(
    @Inject(WalletPaymentService)
    private readonly purchases: WalletPaymentService,
    @Inject(PaymentQuoteService) private readonly quotes: PaymentQuoteService,
  ) {}

  /** Return owner/wallet-bound server pricing with no wallet movement or external purchase. */
  @Post('quotes')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({
    summary:
      'Review service terms and any verified bill recipient before payment',
  })
  @ApiBody({ type: CreatePaymentQuoteDto })
  @ApiResponse({ status: 201, type: PaymentQuoteResponseDto })
  async createQuote(
    @Body() body: CreatePaymentQuoteDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<PaymentQuoteResponseDto> {
    const quote = await this.purchases.createQuote({
      actorId: account.id,
      walletId: body.walletId.toLowerCase(),
      productId: body.productId.toLowerCase(),
      recipientPhoneNumber: body.recipientPhoneNumber,
      contactPhoneNumber: body.contactPhoneNumber,
      merchantRecipientIdentifier: body.merchantRecipientIdentifier,
      accountValidationId: body.accountValidationId?.toLowerCase(),
      bankBeneficiaryValidationId:
        body.bankBeneficiaryValidationId?.toLowerCase(),
      narration: body.narration,
      educationValidationId: body.educationValidationId?.toLowerCase(),
      insuranceApplicationId: body.insuranceApplicationId?.toLowerCase(),
      amountMinorUnits:
        body.amountMinorUnits === undefined
          ? undefined
          : BigInt(body.amountMinorUnits),
    });
    return {
      ...PaymentReviewResponseDto.fromQuote(quote),
      isSubmissionAvailable: await this.quotes.canSubmit(quote),
    };
  }

  /** Retrieve existing review terms, preserving visible expiry rather than silently requoting. */
  @Get('quotes/:quoteId')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({ summary: 'Get an owned quote' })
  @ApiResponse({ status: 200, type: PaymentQuoteResponseDto })
  async getQuote(
    @Param() params: QuoteIdParamsDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<PaymentQuoteResponseDto> {
    const quote = await this.quotes.get(
      account.id,
      params.quoteId.toLowerCase(),
    );
    return {
      ...PaymentReviewResponseDto.fromQuote(quote),
      isSubmissionAvailable: await this.quotes.canSubmit(quote),
    };
  }

  /** Accept explicit consent; status may be pending and must not be interpreted as confirmed service delivery. */
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({
    summary:
      'Submit or resume one quoted service payment using its original request key',
  })
  @ApiBody({ type: SubmitServicePaymentDto })
  @ApiResponse({ status: 200, type: ServicePaymentResponseDto })
  async submit(
    @Body() body: SubmitServicePaymentDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<ServicePaymentResponseDto> {
    return ServicePaymentResponseDto.fromPayment(
      await this.purchases.submit({
        actorId: account.id,
        quoteId: body.quoteId.toLowerCase(),
        requestKey: body.requestKey,
      }),
    );
  }

  /** Recover the original response using the caller's persisted key; no adapter or purchase retry is involved. */
  @Get('by-request-key')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({
    summary: 'Recover payment progress using the original logical request key',
  })
  @ApiResponse({ status: 200, type: ServicePaymentResponseDto })
  async findByRequestKey(
    @Query() query: PaymentRequestIdentityDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<ServicePaymentResponseDto> {
    return ServicePaymentResponseDto.fromPayment(
      await this.purchases.findByRequestKey(account.id, query.requestKey),
    );
  }

  /** Query progress without initiating, reserving or retrying a purchase. */
  @Get(':paymentId')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({ summary: 'Get owned payment progress' })
  @ApiResponse({ status: 200, type: ServicePaymentResponseDto })
  async get(
    @Param() params: PaymentIdParamsDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<ServicePaymentResponseDto> {
    return ServicePaymentResponseDto.fromPayment(
      await this.purchases.get(account.id, params.paymentId.toLowerCase()),
    );
  }

  /** Recover an accepted held instruction under the same logical identity; provider lookup cannot send another purchase. */
  @Post(':paymentId/reconcile')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({
    summary:
      'Reconcile existing held payment and settlement without creating another purchase',
  })
  @ApiResponse({ status: 200, type: ServicePaymentResponseDto })
  async reconcile(
    @Param() params: PaymentIdParamsDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<ServicePaymentResponseDto> {
    return ServicePaymentResponseDto.fromPayment(
      await this.purchases.reconcile(
        account.id,
        params.paymentId.toLowerCase(),
      ),
    );
  }
}
