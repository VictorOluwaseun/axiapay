import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthenticatedAccount } from '../../authentication/decorators/authenticated-account.decorator.js';
import type { AccountIdentity } from '../../authentication/domain/authentication-models.js';
import { AuthenticationGuard } from '../../authentication/guards/authentication.guard.js';
import { WalletIdParamsDto } from '../../wallets/dtos/wallet-request.dto.js';
import { WalletErrorResponseDto } from '../../wallets/dtos/wallet-response.dto.js';
import { money } from '../../wallets/domain/money.js';
import {
  CreateFundingRequestDto,
  FundingIdParamsDto,
  FundingResponseDto,
  FundingOptionResponseDto,
} from '../dtos/funding.dto.js';
import { WalletFundingService } from '../services/wallet-funding.service.js';
import { FundingExceptionFilter } from '../filters/funding-exception.filter.js';

/** Map session-bound funding requests and recovery actions to the business coordinator; no provider evidence is accepted here. */
@ApiTags('wallet funding')
@ApiBearerAuth()
@ApiResponse({ status: 400, type: WalletErrorResponseDto })
@ApiResponse({ status: 401, type: WalletErrorResponseDto })
@ApiResponse({ status: 404, type: WalletErrorResponseDto })
@ApiResponse({ status: 409, type: WalletErrorResponseDto })
@ApiResponse({ status: 503, type: WalletErrorResponseDto })
@UseGuards(AuthenticationGuard)
@UseFilters(FundingExceptionFilter)
@Controller()
export class WalletFundingController {
  /** Delegate authorization and multi-stage funding workflows to the feature service. */
  constructor(
    @Inject(WalletFundingService)
    private readonly funding: WalletFundingService,
  ) {}

  /** Discover supported funding terms for an owned wallet; unconfigured funding returns an empty array. */
  @Get('wallets/:walletId/funding-options')
  @Header('Cache-Control', 'no-store')
  @ApiParam({ name: 'walletId', format: 'uuid' })
  @ApiResponse({ status: 200, type: FundingOptionResponseDto, isArray: true })
  @ApiOperation({ summary: 'List funding options available for this wallet' })
  async listOptions(
    @Param() params: WalletIdParamsDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<FundingOptionResponseDto[]> {
    const options = await this.funding.listOptions(
      account.id,
      params.walletId.toLowerCase(),
    );
    return options.map(FundingOptionResponseDto.fromOption);
  }

  /** Persist terms before redirecting the customer to partner-hosted checkout; repeated keys reuse the same request. */
  @Post('wallets/:walletId/funding-requests')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @ApiParam({ name: 'walletId', format: 'uuid' })
  @ApiBody({ type: CreateFundingRequestDto })
  @ApiResponse({ status: 202, type: FundingResponseDto })
  @ApiOperation({
    summary: 'Start wallet funding with an available AxiaPay funding option',
  })
  async initialize(
    @Param() params: WalletIdParamsDto,
    @Body() body: CreateFundingRequestDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<FundingResponseDto> {
    return FundingResponseDto.fromRequest(
      await this.funding.initialize({
        actorId: account.id,
        walletId: params.walletId.toLowerCase(),
        fundingOptionId: body.fundingOptionId,
        payerEmail: body.payerEmail,
        requestKey: body.requestKey,
        value: money(BigInt(body.amountMinorUnits), body.currency),
      }),
    );
  }

  /** Read funding state from persistent intent and committed ledger receipt, never from a browser redirect. */
  @Get('wallet-funding/:fundingId')
  @Header('Cache-Control', 'no-store')
  @ApiParam({ name: 'fundingId', format: 'uuid' })
  @ApiResponse({ status: 200, type: FundingResponseDto })
  @ApiOperation({ summary: 'Get an owned funding request' })
  async get(
    @Param() params: FundingIdParamsDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<FundingResponseDto> {
    return FundingResponseDto.fromRequest(
      await this.funding.getOwned(account.id, params.fundingId.toLowerCase()),
    );
  }

  /** Request independent server verification after a missed callback; clients supply no success flag or payment amount. */
  @Post('wallet-funding/:fundingId/reconcile')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiParam({ name: 'fundingId', format: 'uuid' })
  @ApiResponse({ status: 200, type: FundingResponseDto })
  @ApiOperation({
    summary: 'Reconcile an owned funding request with the partner',
  })
  async reconcile(
    @Param() params: FundingIdParamsDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<FundingResponseDto> {
    return FundingResponseDto.fromRequest(
      await this.funding.reconcile(account.id, params.fundingId.toLowerCase()),
    );
  }
}
