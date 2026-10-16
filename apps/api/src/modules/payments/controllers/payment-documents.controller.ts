import {
  Controller,
  Get,
  Header,
  Inject,
  Param,
  StreamableFile,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProduces,
  ApiProperty,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { IsUUID, Matches } from 'class-validator';
import { AuthenticatedAccount } from '../../authentication/decorators/authenticated-account.decorator.js';
import type { AccountIdentity } from '../../authentication/domain/authentication-models.js';
import { AuthenticationGuard } from '../../authentication/guards/authentication.guard.js';
import { PaymentDocumentService } from '@axiapay/payments-runtime/modules/payments/services/payment-document.service';
import { PaymentExceptionFilter } from '../filters/payment-exception.filter.js';
import { PaymentErrorResponseDto } from '../dtos/payment-response.dto.js';

/** First-party payment/document identities; callers cannot supply upstream locations or arbitrary attachment names. */
export class PaymentDocumentParamsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  readonly paymentId!: string;
  @ApiProperty({ maxLength: 50 })
  @Matches(/^[a-z0-9][a-z0-9-]{0,49}(?![\s\S])/)
  readonly documentId!: string;
}

/** Deliver owner-authorized issued PDFs with no caching, redirects or exposed upstream references. */
@ApiTags('payment-documents')
@ApiBearerAuth()
@UseGuards(AuthenticationGuard)
@UseFilters(PaymentExceptionFilter)
@ApiResponse({ status: 401, type: PaymentErrorResponseDto })
@ApiResponse({ status: 404, type: PaymentErrorResponseDto })
@ApiResponse({ status: 503, type: PaymentErrorResponseDto })
@Controller('payments/:paymentId/documents')
export class PaymentDocumentsController {
  /** Delegate authorization and bounded authenticated retrieval to the document service. */
  constructor(
    @Inject(PaymentDocumentService)
    private readonly documents: PaymentDocumentService,
  ) {}

  /** Stream a verified PDF using a deterministic safe first-party attachment name; document retrieval never sends another purchase. */
  @Get(':documentId')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiProduces('application/pdf')
  @ApiOperation({ summary: 'Download an owned issued payment document' })
  @ApiResponse({
    status: 200,
    content: {
      'application/pdf': { schema: { type: 'string', format: 'binary' } },
    },
  })
  async retrieve(
    @Param() params: PaymentDocumentParamsDto,
    @AuthenticatedAccount() account: AccountIdentity,
  ): Promise<StreamableFile> {
    const paymentId = params.paymentId.toLowerCase();
    const bytes = await this.documents.retrieve(
      account.id,
      paymentId,
      params.documentId,
    );
    return new StreamableFile(Buffer.from(bytes), {
      type: 'application/pdf',
      disposition: `attachment; filename="${paymentId}-${params.documentId}.pdf"`,
      length: bytes.byteLength,
    });
  }
}
