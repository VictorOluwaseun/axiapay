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
import { ServiceCatalogService } from '../../service-catalog/services/service-catalog.service.js';
import { BankTransferService } from '../services/bank-transfer.service.js';
import { BankBeneficiaryService } from '../services/bank-beneficiary.service.js';
import { PaymentQuoteService } from '../services/payment-quote.service.js';
import { PaymentExceptionFilter } from '../filters/payment-exception.filter.js';
import { PaymentErrorResponseDto } from '../dtos/payment-response.dto.js';
import {
  PaymentRequestIdentityDto,
  QuoteIdParamsDto,
} from '../dtos/payment-request.dto.js';
import {
  BankBeneficiaryIdParamsDto,
  BankBeneficiaryValidationResponseDto,
  BankDirectoryQueryDto,
  BankIdParamsDto,
  BankPageResponseDto,
  BankResponseDto,
  BankTransferIdParamsDto,
  BankTransferProductPageResponseDto,
  BankTransferProductQueryDto,
  BankTransferProductResponseDto,
  BankTransferQuoteResponseDto,
  BankTransferResponseDto,
  BankTransferReviewResponseDto,
  CreateBankBeneficiaryValidationDto,
  CreateBankTransferQuoteDto,
  SubmitBankTransferDto,
} from '../dtos/bank-transfer.dto.js';

/** Deliver authenticated first-party bank directory, name enquiry, reviewed transfers and recovery; services alone own permissions, pricing and money movements. */
@ApiTags('bank-transfers')
@ApiBearerAuth()
@ApiResponse({ status: 400, type: PaymentErrorResponseDto })
@ApiResponse({ status: 401, type: PaymentErrorResponseDto })
@ApiResponse({ status: 404, type: PaymentErrorResponseDto })
@ApiResponse({ status: 409, type: PaymentErrorResponseDto })
@ApiResponse({ status: 503, type: PaymentErrorResponseDto })
@UseGuards(AuthenticationGuard)
@UseFilters(PaymentExceptionFilter)
@Controller('bank-transfers')
export class BankTransfersController {
  /** Inject focused feature workflows; no database, Redis or concrete provider client enters the HTTP boundary. */
  constructor(
    @Inject(ServiceCatalogService)
    private readonly catalogue: ServiceCatalogService,
    @Inject(BankBeneficiaryService)
    private readonly beneficiaries: BankBeneficiaryService,
    @Inject(BankTransferService)
    private readonly transfers: BankTransferService,
    @Inject(PaymentQuoteService) private readonly quotes: PaymentQuoteService,
  ) {}

  /** Browse published bank profiles without verifying a recipient or initiating a transfer. */
  @Get('banks')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({ summary: 'List supported first-party bank profiles' })
  @ApiResponse({ status: 200, type: BankPageResponseDto })
  async listBanks(
    @Query() query: BankDirectoryQueryDto,
  ): Promise<BankPageResponseDto> {
    return BankPageResponseDto.fromPage(
      await this.catalogue.listBanks({
        currency: query.currency,
        countryCode: query.countryCode,
        afterId: query.afterId?.toLowerCase(),
        limit: Number(query.limit ?? '50'),
      }),
    );
  }

  /** Read the selected enabled bank revision, excluding upstream routing codes and credentials. */
  @Get('banks/:bankId')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({ summary: 'Get first-party bank account rules' })
  @ApiResponse({ status: 200, type: BankResponseDto })
  async getBank(@Param() params: BankIdParamsDto): Promise<BankResponseDto> {
    return BankResponseDto.fromBank(
      await this.catalogue.getBank(params.bankId.toLowerCase()),
    );
  }

  /** Return transfer-only pricing/limits and explicit deployment availability. */
  @Get('products')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({
    summary: 'List enabled bank transfer product revisions and fees',
  })
  @ApiResponse({ status: 200, type: BankTransferProductPageResponseDto })
  async listProducts(
    @Query() query: BankTransferProductQueryDto,
  ): Promise<BankTransferProductPageResponseDto> {
    const page = await this.transfers.listProducts({
      bankId: query.bankId?.toLowerCase(),
      currency: query.currency,
      afterId: query.afterId?.toLowerCase(),
      limit: Number(query.limit ?? '50'),
    });
    return {
      products: page.products.map((product) =>
        BankTransferProductResponseDto.fromProduct(
          product,
          this.quotes.isProductSubmissionAvailable(product),
        ),
      ),
      nextCursor: page.nextCursor,
    };
  }

  /** Resolve a bank account through a non-spending authenticated name enquiry. */
  @Post('beneficiary-validations')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({ summary: 'Verify a bank beneficiary before transfer review' })
  @ApiBody({ type: CreateBankBeneficiaryValidationDto })
  @ApiResponse({ status: 201, type: BankBeneficiaryValidationResponseDto })
  async verifyBeneficiary(
    @Body() body: CreateBankBeneficiaryValidationDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<BankBeneficiaryValidationResponseDto> {
    return BankBeneficiaryValidationResponseDto.fromValidation(
      await this.beneficiaries.verify({
        actorId: account.id,
        productId: body.productId.toLowerCase(),
        accountNumber: body.accountNumber,
      }),
    );
  }

  /** Recover the owning customer's immutable recipient evidence, including actual expiry. */
  @Get('beneficiary-validations/:validationId')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({ summary: 'Get owned bank beneficiary validation' })
  @ApiResponse({ status: 200, type: BankBeneficiaryValidationResponseDto })
  async getBeneficiary(
    @Param() params: BankBeneficiaryIdParamsDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<BankBeneficiaryValidationResponseDto> {
    return BankBeneficiaryValidationResponseDto.fromValidation(
      await this.beneficiaries.get(
        account.id,
        params.validationId.toLowerCase(),
      ),
    );
  }

  /** Price exactly the reviewed recipient credit and total wallet debit, without holding funds. */
  @Post('quotes')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({
    summary:
      'Review verified bank recipient, transfer amount, fee and debit before consent',
  })
  @ApiBody({ type: CreateBankTransferQuoteDto })
  @ApiResponse({ status: 201, type: BankTransferQuoteResponseDto })
  async createQuote(
    @Body() body: CreateBankTransferQuoteDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<BankTransferQuoteResponseDto> {
    const quote = await this.transfers.createQuote({
      actorId: account.id,
      walletId: body.walletId.toLowerCase(),
      productId: body.productId.toLowerCase(),
      bankBeneficiaryValidationId:
        body.bankBeneficiaryValidationId.toLowerCase(),
      amountMinorUnits: BigInt(body.amountMinorUnits),
      narration: body.narration,
    });
    return {
      ...BankTransferReviewResponseDto.fromQuote(quote),
      isSubmissionAvailable: await this.quotes.canSubmit(quote),
    };
  }

  /** Observe reviewed transfer terms after expiry or bank withdrawal without silently repricing or substituting the recipient. */
  @Get('quotes/:quoteId')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({ summary: 'Get an owned bank transfer quote' })
  @ApiResponse({ status: 200, type: BankTransferQuoteResponseDto })
  async getQuote(
    @Param() params: QuoteIdParamsDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<BankTransferQuoteResponseDto> {
    const quote = await this.transfers.getQuote(
      account.id,
      params.quoteId.toLowerCase(),
    );
    return {
      ...BankTransferReviewResponseDto.fromQuote(quote),
      isSubmissionAvailable: await this.quotes.canSubmit(quote),
    };
  }

  /** Submit explicit consent under one durable logical identity; pending acknowledgement cannot be treated as recipient credit. */
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({ summary: 'Submit or resume one reviewed bank transfer' })
  @ApiBody({ type: SubmitBankTransferDto })
  @ApiResponse({ status: 200, type: BankTransferResponseDto })
  async submit(
    @Body() body: SubmitBankTransferDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<BankTransferResponseDto> {
    return BankTransferResponseDto.fromTransfer(
      await this.transfers.submit({
        actorId: account.id,
        quoteId: body.quoteId.toLowerCase(),
        requestKey: body.requestKey,
      }),
    );
  }

  /** Recover the original transfer response after uncertainty, without an adapter call or another transfer. */
  @Get('by-request-key')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({
    summary: 'Recover owned bank transfer using its original request key',
  })
  @ApiResponse({ status: 200, type: BankTransferResponseDto })
  async findByRequestKey(
    @Query() query: PaymentRequestIdentityDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<BankTransferResponseDto> {
    return BankTransferResponseDto.fromTransfer(
      await this.transfers.findByRequestKey(account.id, query.requestKey),
    );
  }

  /** Read owned immutable transfer and journal progress without initiating provider I/O. */
  @Get(':transferId')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({
    summary: 'Get owned bank transfer progress and credit reference',
  })
  @ApiResponse({ status: 200, type: BankTransferResponseDto })
  async get(
    @Param() params: BankTransferIdParamsDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<BankTransferResponseDto> {
    return BankTransferResponseDto.fromTransfer(
      await this.transfers.get(account.id, params.transferId.toLowerCase()),
    );
  }

  /** Query/recover the original held instruction; settle stored safe evidence without repeating submission. */
  @Post(':transferId/reconcile')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({
    summary: 'Reconcile existing bank transfer and wallet settlement',
  })
  @ApiResponse({ status: 200, type: BankTransferResponseDto })
  async reconcile(
    @Param() params: BankTransferIdParamsDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<BankTransferResponseDto> {
    return BankTransferResponseDto.fromTransfer(
      await this.transfers.reconcile(
        account.id,
        params.transferId.toLowerCase(),
      ),
    );
  }
}
