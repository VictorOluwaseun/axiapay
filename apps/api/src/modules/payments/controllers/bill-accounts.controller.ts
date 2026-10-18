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
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthenticatedAccount } from '../../authentication/decorators/authenticated-account.decorator.js';
import type { AccountIdentity } from '../../authentication/domain/authentication-models.js';
import { AuthenticationGuard } from '../../authentication/guards/authentication.guard.js';
import { BillAccountService } from '@axiapay/payments-runtime/modules/payments/services/bill-account.service';
import {
  BillAccountValidationIdParamsDto,
  BillAccountValidationResponseDto,
  CreateBillAccountValidationDto,
} from '../dtos/bill-account.dto.js';
import { PaymentErrorResponseDto } from '../dtos/payment-response.dto.js';
import { PaymentExceptionFilter } from '../filters/payment-exception.filter.js';

/** Expose owner-scoped non-financial bill-account verification; no route accepts a client claim that an account is verified. */
@ApiTags('bill-accounts')
@ApiBearerAuth()
@ApiResponse({ status: 400, type: PaymentErrorResponseDto })
@ApiResponse({ status: 401, type: PaymentErrorResponseDto })
@ApiResponse({ status: 403, type: PaymentErrorResponseDto })
@ApiResponse({ status: 404, type: PaymentErrorResponseDto })
@ApiResponse({ status: 503, type: PaymentErrorResponseDto })
@UseGuards(AuthenticationGuard)
@UseFilters(PaymentExceptionFilter)
@Controller('payments/account-validations')
export class BillAccountsController {
  /** Inject recipient verification, leaving provider protocol and persistence out of the HTTP boundary. */
  constructor(
    @Inject(BillAccountService)
    private readonly billAccounts: BillAccountService,
  ) {}

  /** Verify a decoder/customer/meter account for the selected immutable bill product without a purchase or wallet hold. */
  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({
    summary: 'Verify a TV or electricity recipient before quote review',
  })
  @ApiBody({ type: CreateBillAccountValidationDto })
  @ApiResponse({ status: 201, type: BillAccountValidationResponseDto })
  async verify(
    @Body() body: CreateBillAccountValidationDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<BillAccountValidationResponseDto> {
    return BillAccountValidationResponseDto.fromValidation(
      await this.billAccounts.verify({
        actorId: account.id,
        productId: body.productId.toLowerCase(),
        accountNumber: body.accountNumber,
      }),
    );
  }

  /** Recover the owning customer's immutable validation details, with visible expiry and no repeat verification side effect. */
  @Get(':validationId')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({ summary: 'Get owned bill-account validation evidence' })
  @ApiResponse({ status: 200, type: BillAccountValidationResponseDto })
  async get(
    @Param() params: BillAccountValidationIdParamsDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<BillAccountValidationResponseDto> {
    return BillAccountValidationResponseDto.fromValidation(
      await this.billAccounts.get(
        account.id,
        params.validationId.toLowerCase(),
      ),
    );
  }
}
