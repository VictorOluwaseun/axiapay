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
import { EducationRecipientService } from '../services/education-recipient.service.js';
import { InsuranceApplicationService } from '../services/insurance-application.service.js';
import {
  CreateEducationValidationDto,
  CreateInsuranceApplicationDto,
  EducationValidationResponseDto,
  InsuranceApplicationResponseDto,
  PreparationIdParamsDto,
} from '../dtos/education-insurance.dto.js';
import { PaymentErrorResponseDto } from '../dtos/payment-response.dto.js';
import { PaymentExceptionFilter } from '../filters/payment-exception.filter.js';

/** Deliver authenticated non-financial education and insurance preparation; verification, terms and eligibility rules stay in feature services. */
@ApiTags('education-insurance')
@ApiBearerAuth()
@ApiResponse({ status: 400, type: PaymentErrorResponseDto })
@ApiResponse({ status: 401, type: PaymentErrorResponseDto })
@ApiResponse({ status: 404, type: PaymentErrorResponseDto })
@ApiResponse({ status: 409, type: PaymentErrorResponseDto })
@ApiResponse({ status: 503, type: PaymentErrorResponseDto })
@UseGuards(AuthenticationGuard)
@UseFilters(PaymentExceptionFilter)
@Controller('payments')
export class EducationInsuranceController {
  /** Inject dedicated preparation workflows without database or concrete external clients. */
  constructor(
    @Inject(EducationRecipientService)
    private readonly education: EducationRecipientService,
    @Inject(InsuranceApplicationService)
    private readonly insurance: InsuranceApplicationService,
  ) {}

  /** Verify the selected institution beneficiary without authorizing funds. */
  @Post('education-validations')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({
    summary: 'Verify an education beneficiary before quote review',
  })
  @ApiBody({ type: CreateEducationValidationDto })
  @ApiResponse({ status: 201, type: EducationValidationResponseDto })
  async verifyEducation(
    @Body() body: CreateEducationValidationDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<EducationValidationResponseDto> {
    return EducationValidationResponseDto.fromValidation(
      await this.education.verify({
        actorId: account.id,
        productId: body.productId.toLowerCase(),
        beneficiaryIdentifier: body.beneficiaryIdentifier,
      }),
    );
  }

  /** Recover only the owning customer's verified beneficiary snapshot. */
  @Get('education-validations/:preparationId')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({ summary: 'Get an owned education beneficiary validation' })
  @ApiResponse({ status: 200, type: EducationValidationResponseDto })
  async getEducation(
    @Param() params: PreparationIdParamsDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<EducationValidationResponseDto> {
    return EducationValidationResponseDto.fromValidation(
      await this.education.get(account.id, params.preparationId.toLowerCase()),
    );
  }

  /** Accept explicit reviewed terms, typed insured fields and requested dates, then confirm eligibility without purchasing. */
  @Post('insurance-applications')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({
    summary:
      'Record consented eligible fixed-premium insurance details before payment',
  })
  @ApiBody({ type: CreateInsuranceApplicationDto })
  @ApiResponse({ status: 201, type: InsuranceApplicationResponseDto })
  async createInsurance(
    @Body() body: CreateInsuranceApplicationDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<InsuranceApplicationResponseDto> {
    return InsuranceApplicationResponseDto.fromApplication(
      await this.insurance.create({
        ...body,
        actorId: account.id,
        productId: body.productId.toLowerCase(),
      }),
    );
  }

  /** Recover consent/eligibility evidence without claiming a paid or issued policy. */
  @Get('insurance-applications/:preparationId')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({ summary: 'Get an owned insurance application' })
  @ApiResponse({ status: 200, type: InsuranceApplicationResponseDto })
  async getInsurance(
    @Param() params: PreparationIdParamsDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<InsuranceApplicationResponseDto> {
    return InsuranceApplicationResponseDto.fromApplication(
      await this.insurance.get(account.id, params.preparationId.toLowerCase()),
    );
  }
}
