import { Inject, Injectable } from '@nestjs/common';
import { ServiceCatalogService } from '@axiapay/backend/modules/service-catalog/services/service-catalog.service';
import type { ProductPage } from '@axiapay/backend/modules/service-catalog/domain/service-product';
import {
  PaymentError,
  type PaymentQuote,
  type ServicePayment,
} from '@axiapay/backend/modules/payments/domain/payment';
import { PaymentQuoteService } from '@axiapay/backend/modules/payments/services/payment-quote.service';
import { WalletPaymentService } from '@axiapay/backend/modules/payments/services/wallet-payment.service';

/** Own bank-transfer category authorization and review/submission/recovery coordination while reusing the single authoritative wallet/payment execution workflow. */
@Injectable()
export class BankTransferService {
  /** Keep transfer contracts separate from provider protocol, storage and journal mutation. */
  constructor(
    @Inject(ServiceCatalogService)
    private readonly catalogue: ServiceCatalogService,
    @Inject(PaymentQuoteService) private readonly quotes: PaymentQuoteService,
    @Inject(WalletPaymentService)
    private readonly purchases: WalletPaymentService,
  ) {}

  /** Discover only published bank transfer revisions with normalized effective filters; callers cannot substitute a service category. */
  listProducts(input: {
    readonly bankId?: string;
    readonly currency?: string;
    readonly afterId?: string;
    readonly limit: number;
  }): Promise<ProductPage> {
    return this.catalogue.listProducts({
      ...input,
      serviceType: 'bank_transfer',
    });
  }

  /** Bind reviewed recipient, amount and optional narration to an owned wallet, using server pricing and fresh name-enquiry evidence. */
  async createQuote(input: {
    readonly actorId: string;
    readonly walletId: string;
    readonly productId: string;
    readonly bankBeneficiaryValidationId: string;
    readonly amountMinorUnits: bigint;
    readonly narration?: string;
  }): Promise<PaymentQuote> {
    const product = await this.catalogue.getProduct(input.productId);
    if (product.serviceType !== 'bank_transfer') {
      throw new PaymentError('INVALID_PAYMENT');
    }
    return this.purchases.createQuote(input);
  }

  /** Recover owner-scoped transfer terms even after expiry or bank withdrawal; other service quotes are inaccessible through this feature. */
  async getQuote(actorId: string, quoteId: string): Promise<PaymentQuote> {
    const quote = await this.quotes.get(actorId, quoteId);
    assertBankTransferQuote(quote);
    return quote;
  }

  /** Authorize only a reviewed bank transfer and reuse its original logical identity; duplicate or uncertain requests cannot initiate another transfer. */
  async submit(input: {
    readonly actorId: string;
    readonly quoteId: string;
    readonly requestKey: string;
  }): Promise<ServicePayment> {
    await this.getQuote(input.actorId, input.quoteId);
    return this.purchases.submit(input);
  }

  /** Observe owned transfer evidence without adapter I/O, new holds or repeat spending. */
  async get(actorId: string, transferId: string): Promise<ServicePayment> {
    const payment = await this.purchases.get(actorId, transferId);
    assertBankTransferQuote(payment.quote);
    return payment;
  }

  /** Recover a lost transfer response under the owner-scoped key shared by all payment channels and categories. */
  async findByRequestKey(
    actorId: string,
    requestKey: string,
  ): Promise<ServicePayment> {
    const payment = await this.purchases.findByRequestKey(actorId, requestKey);
    assertBankTransferQuote(payment.quote);
    return payment;
  }

  /** Check ownership/category before recovering the existing held transfer; stored final evidence settles without another provider submission. */
  async reconcile(
    actorId: string,
    transferId: string,
  ): Promise<ServicePayment> {
    await this.get(actorId, transferId);
    return this.purchases.reconcile(actorId, transferId);
  }
}

/** Guard feature boundaries within application operations, preventing bank routes from authorizing unrelated purchase quotes. */
function assertBankTransferQuote(quote: PaymentQuote): void {
  if (
    quote.serviceType !== 'bank_transfer' ||
    !quote.bankBeneficiaryValidation
  ) {
    throw new PaymentError('BANK_TRANSFER_NOT_FOUND');
  }
}
