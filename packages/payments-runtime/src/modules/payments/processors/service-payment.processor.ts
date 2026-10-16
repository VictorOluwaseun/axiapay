import { PaymentError, type ServicePayment } from '../domain/payment.js';
import type { ServiceType } from '../../service-catalog/domain/service-product.js';
import type { ServiceProcessorAdapter } from '../ports/service-processor-adapter.js';
import type {
  PaymentTermsInput,
  ProviderPaymentResult,
  ServicePaymentProvider,
} from '../ports/service-payment-provider.js';

/** Share the stateless request → execution → submission pipeline across services. Financial authorization, result correlation, recovery and settlement remain in payment services. */
export class ServicePaymentProcessor<
  ProviderRequest,
  ProviderResponse,
> implements ServicePaymentProvider {
  /** Bind one service category to an explicitly injected protocol; no provider client or framework enters this processor. */
  constructor(
    private readonly serviceType: ServiceType,
    private readonly adapter: ServiceProcessorAdapter<
      ProviderRequest,
      ProviderResponse
    >,
  ) {}

  /** Protect service/account routing and delegate product-specific purchase encodings to their adapter owner. */
  validate(target: PaymentTermsInput): void {
    this.assertProviderIdentity(target.terms);
    this.adapter.validate?.(target);
  }

  /** Validate one fresh purchase and then observe current terms; both stages have one owner and never purchase or mutate a wallet. */
  async preparePurchase(
    quote: import('../domain/payment.js').PaymentQuote,
  ): Promise<void> {
    this.validate({ scope: 'quote', terms: quote });
    await this.adapter.verifyPurchaseTerms?.(quote);
  }

  /** Check external terms during review only when the protocol supplies that capability; other quotes retain their existing availability reporting. */
  async verifyPurchaseTerms(
    quote: import('../domain/payment.js').PaymentQuote,
  ): Promise<void> {
    if (!this.adapter.verifyPurchaseTerms) {
      return;
    }
    await this.preparePurchase(quote);
  }

  /** Execute one already-claimed purchase; propagate uncertainty without adding a retry or financial mutation. */
  async submit(payment: ServicePayment): Promise<ProviderPaymentResult> {
    this.validate({ scope: 'quote', terms: payment.quote });
    const request = this.adapter.toRequest(payment);
    const response = await this.adapter.execute(request);
    return this.adapter.toSubmission(response, payment);
  }

  /** Retain accepted snapshots during recovery; lookup never enters any purchase stage or current purchase validator. */
  async lookup(payment: ServicePayment): Promise<ProviderPaymentResult> {
    this.assertProviderIdentity(payment.quote);
    return this.adapter.lookup(payment);
  }

  /** Reject cross-service or changed credential-realm routing before invoking any adapter method. */
  private assertProviderIdentity(terms: PaymentTermsInput['terms']): void {
    if (terms.serviceType !== this.serviceType) {
      throw new PaymentError('INVALID_PAYMENT', {
        reason: 'SERVICE_NOT_SUPPORTED',
      });
    }
    if (terms.providerKey !== this.adapter.providerKey) {
      throw new PaymentError('PAYMENT_UNAVAILABLE', {
        reason: 'PROVIDER_ROUTE_MISMATCH',
      });
    }
  }
}
