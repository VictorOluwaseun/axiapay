import {
  Controller,
  Header,
  HttpCode,
  Inject,
  Post,
  Req,
  UseFilters,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { WalletFundingService } from '../services/wallet-funding.service.js';
import {
  PROVIDER_FUNDING,
  type ProviderFundingClients,
} from './provider-funding.module.js';
import { FundingError } from '../domain/funding.js';
import { FundingExceptionFilter } from '../filters/funding-exception.filter.js';

/** Minimal raw HTTP evidence; signatures are verified before trusting payment identities or metadata. */
interface FundingWebhookRequest {
  readonly rawBody?: Buffer;
  readonly headers: { readonly 'x-paystack-signature'?: string | string[] };
}

/** Receive provider callbacks using partner authentication, not customer bearer tokens; acknowledge only committed or irrelevant events. */
@ApiTags('funding webhooks')
@ApiResponse({
  status: 200,
  description:
    'Committed credit, identical replay, or authenticated irrelevant event.',
})
@ApiResponse({ status: 401, description: 'Invalid partner signature.' })
@ApiResponse({
  status: 503,
  description: 'Unacknowledged dependency failure; retry the notification.',
})
@UseFilters(FundingExceptionFilter)
@Controller('webhooks/wallet-funding')
export class FundingWebhookController {
  /** Inject the workflow coordinator; the controller does not parse provider financial claims. */
  constructor(
    @Inject(WalletFundingService)
    private readonly funding: WalletFundingService,
    @Inject(PROVIDER_FUNDING.clients)
    private readonly clients: ProviderFundingClients,
  ) {}

  /** Pass the original bytes and a single Paystack signature header to its dedicated verifier. */
  @Post('paystack')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Receive a signed Paystack funding webhook' })
  async paystack(@Req() request: FundingWebhookRequest): Promise<void> {
    const signature = request.headers['x-paystack-signature'];
    if (!request.rawBody || typeof signature !== 'string') {
      throw new FundingError('INVALID_WEBHOOK');
    }
    const adapter = this.clients.paystack;
    if (!adapter) {
      throw new FundingError('FUNDING_UNAVAILABLE');
    }
    const notification = adapter.authenticateNotification(
      request.rawBody,
      signature,
    );
    if (!notification) {
      return;
    }
    await this.funding.receiveNotification({
      ...notification,
      adapterId: 'paystack',
      environment: adapter.environment,
      partnerAccountId: adapter.partnerAccountId,
    });
  }

  /** OPay carries its callback MAC inside its signed envelope; the adapter handles its distinct canonicalization. */
  @Post('opay')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Receive a signed OPay funding webhook' })
  async opay(@Req() request: FundingWebhookRequest): Promise<void> {
    if (!request.rawBody) {
      throw new FundingError('INVALID_WEBHOOK');
    }
    const adapter = this.clients.opay;
    if (!adapter) {
      throw new FundingError('FUNDING_UNAVAILABLE');
    }
    const notification = adapter.authenticateNotification(request.rawBody);
    if (!notification) {
      return;
    }
    await this.funding.receiveNotification({
      ...notification,
      adapterId: 'opay',
      environment: adapter.environment,
      partnerAccountId: adapter.partnerAccountId,
    });
  }
}
