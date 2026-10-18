import {
  Controller,
  Get,
  Header,
  Inject,
  Param,
  Query,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthenticationGuard } from '../../authentication/guards/authentication.guard.js';
import { ServiceCatalogService } from '@axiapay/payments-runtime/modules/service-catalog/services/service-catalog.service';
import { PaymentQuoteService } from '@axiapay/payments-runtime/modules/payments/services/payment-quote.service';
import {
  ProductIdParamsDto,
  ProductQueryDto,
} from '../dtos/payment-request.dto.js';
import {
  PaymentErrorResponseDto,
  ServiceProductPageResponseDto,
  ServiceProductResponseDto,
} from '../dtos/payment-response.dto.js';
import { PaymentExceptionFilter } from '../filters/payment-exception.filter.js';

/** Expose first-party service catalogue revisions with deployment capability, omitting adapter routing and credentials. */
@ApiTags('service-catalog')
@ApiBearerAuth()
@ApiResponse({ status: 400, type: PaymentErrorResponseDto })
@ApiResponse({ status: 401, type: PaymentErrorResponseDto })
@ApiResponse({ status: 403, type: PaymentErrorResponseDto })
@ApiResponse({ status: 404, type: PaymentErrorResponseDto })
@ApiResponse({ status: 503, type: PaymentErrorResponseDto })
@UseGuards(AuthenticationGuard)
@UseFilters(PaymentExceptionFilter)
@Controller('service-catalog/products')
export class ServiceCatalogController {
  /** Use feature operations for discovery and capability, with no storage or provider dependencies. */
  constructor(
    @Inject(ServiceCatalogService)
    private readonly catalogue: ServiceCatalogService,
    @Inject(PaymentQuoteService) private readonly quotes: PaymentQuoteService,
  ) {}

  /** Return a filtered bounded page; network selection stays explicit, including for ported numbers. */
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({
    summary: 'List enabled service products and purchase availability',
  })
  @ApiResponse({ status: 200, type: ServiceProductPageResponseDto })
  async list(
    @Query() query: ProductQueryDto,
  ): Promise<ServiceProductPageResponseDto> {
    const page = await this.catalogue.listProducts({
      serviceType: query.serviceType,
      bankId: query.bankId?.toLowerCase(),
      currency: query.currency,
      billerCode: query.billerCode,
      electricityMeterType: query.electricityMeterType,
      networkCode: query.networkCode,
      afterId: query.afterId?.toLowerCase(),
      limit: Number(query.limit ?? '50'),
    });
    return {
      products: await Promise.all(
        page.products.map(async (product) =>
          ServiceProductResponseDto.fromProduct(
            product,
            await this.quotes.isProductSubmissionAvailable(product),
          ),
        ),
      ),
      nextCursor: page.nextCursor,
    };
  }

  /** Resolve an enabled service revision by AxiaPay ID, returning no upstream product identifier. */
  @Get(':productId')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({ summary: 'Get service product terms' })
  @ApiResponse({ status: 200, type: ServiceProductResponseDto })
  async get(
    @Param() params: ProductIdParamsDto,
  ): Promise<ServiceProductResponseDto> {
    const product = await this.catalogue.getProduct(
      params.productId.toLowerCase(),
    );
    return ServiceProductResponseDto.fromProduct(
      product,
      await this.quotes.isProductSubmissionAvailable(product),
    );
  }
}
