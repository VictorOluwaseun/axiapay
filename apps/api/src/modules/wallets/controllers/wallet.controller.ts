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
import { WalletService } from '../services/wallet.service.js';
import { money } from '../domain/money.js';
import {
  CreateWalletDto,
  TransferWalletFundsDto,
  WalletIdParamsDto,
} from '../dtos/wallet-request.dto.js';
import {
  WalletBalanceResponseDto,
  WalletErrorResponseDto,
  WalletTransferResponseDto,
} from '../dtos/wallet-response.dto.js';
import { WalletExceptionFilter } from '../filters/wallet-exception.filter.js';

/** Bind validated requests to the authenticated owner; wallet services enforce all monetary and ownership rules. */
@ApiTags('wallets')
@ApiBearerAuth()
@ApiResponse({
  status: 400,
  type: WalletErrorResponseDto,
  description: 'Invalid request shape, identifier, currency, or amount.',
})
@ApiResponse({
  status: 401,
  type: WalletErrorResponseDto,
  description: 'Missing, invalid, expired, revoked, or disabled session.',
})
@ApiResponse({
  status: 503,
  type: WalletErrorResponseDto,
  description:
    'Outcome may be uncertain. Retry a transfer with its original request key and terms.',
})
@UseGuards(AuthenticationGuard)
@UseFilters(WalletExceptionFilter)
@Controller('wallets')
export class WalletController {
  /** Inject business operations only; storage and session validation belong to their respective collaborators. */
  constructor(@Inject(WalletService) private readonly wallets: WalletService) {}

  /** Provision or return the caller's owner/currency wallet without accepting an owner or initial balance. */
  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({
    summary: 'Create or retrieve the current account’s wallet for a currency',
  })
  @ApiBody({ type: CreateWalletDto })
  @ApiResponse({ status: 201, type: WalletBalanceResponseDto })
  async createWallet(
    @Body() body: CreateWalletDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<WalletBalanceResponseDto> {
    const wallet = await this.wallets.createWallet({
      actorId: account.id,
      currency: body.currency,
    });
    return WalletBalanceResponseDto.fromWallet(wallet);
  }

  /** Return an owner-authorized authoritative snapshot, with exact string amounts and no cache. */
  @Get(':walletId/balance')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiParam({ name: 'walletId', format: 'uuid' })
  @ApiOperation({ summary: 'Get the current balance of an owned wallet' })
  @ApiResponse({ status: 200, type: WalletBalanceResponseDto })
  @ApiResponse({
    status: 404,
    type: WalletErrorResponseDto,
    description: 'Wallet does not exist or is not owned by this account.',
  })
  async getBalance(
    @Param() params: WalletIdParamsDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<WalletBalanceResponseDto> {
    const wallet = await this.wallets.getWalletBalance({
      actorId: account.id,
      walletId: params.walletId.toLowerCase(),
    });
    return WalletBalanceResponseDto.fromWallet(wallet);
  }

  /** Submit an internal transfer under the session owner's logical request identity; replay returns the committed receipt. */
  @Post(':walletId/transfers')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiParam({ name: 'walletId', format: 'uuid' })
  @ApiBody({ type: TransferWalletFundsDto })
  @ApiOperation({
    summary:
      'Transfer funds from an owned wallet to another wallet in the same currency',
  })
  @ApiResponse({ status: 200, type: WalletTransferResponseDto })
  @ApiResponse({
    status: 404,
    type: WalletErrorResponseDto,
    description: 'Wallet missing or source wallet not owned by this account.',
  })
  @ApiResponse({
    status: 409,
    type: WalletErrorResponseDto,
    description:
      'Insufficient funds, restricted wallet, currency mismatch, or conflicting request key.',
  })
  async transfer(
    @Param() params: WalletIdParamsDto,
    @Body() body: TransferWalletFundsDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<WalletTransferResponseDto> {
    const receipt = await this.wallets.transferBetweenWallets({
      actorId: account.id,
      sourceWalletId: params.walletId.toLowerCase(),
      destinationWalletId: body.destinationWalletId.toLowerCase(),
      requestKey: body.requestKey,
      value: money(BigInt(body.amountMinorUnits), body.currency),
    });
    return { operationId: receipt.operationId };
  }
}
