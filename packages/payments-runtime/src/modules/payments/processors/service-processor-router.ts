import {
  PaymentError,
  type PaymentQuote,
  type ServicePayment,
} from '../domain/payment.js';
import type { ServiceType } from '../../service-catalog/domain/service-product.js';
import type {
  PaymentTermsInput,
  ProviderPaymentResult,
  ServicePaymentProvider,
} from '../ports/service-payment-provider.js';

/** Route one provider account to category processors without changing accepted provider identities or duplicating payment workflows. */
export class ServiceProcessorRouter implements ServicePaymentProvider {
  private readonly processors: ReadonlyMap<ServiceType, ServicePaymentProvider>;
  /** Copy explicitly composed processors; callers cannot mutate the routing table after construction. */
  constructor(
    processors: Readonly<Partial<Record<ServiceType, ServicePaymentProvider>>>,
  ) {
    this.processors = new Map(
      Object.entries(processors) as [ServiceType, ServicePaymentProvider][],
    );
  }
  /** Delegate only to the selected first-party service's protocol validation. */
  validate(target: PaymentTermsInput): void {
    this.forService(target.terms.serviceType).validate?.(target);
  }
  /** Delegate one preparation operation; providers exposing only separate legacy hooks retain their ordered validation/observation contract. */
  async preparePurchase(quote: PaymentQuote): Promise<void> {
    const processor = this.forService(quote.serviceType);
    if (processor.preparePurchase) {
      await processor.preparePurchase(quote);
      return;
    }
    processor.validate?.({ scope: 'quote', terms: quote });
    await processor.verifyPurchaseTerms?.(quote);
  }
  /** Recheck current provider terms only before a new review or financial hold. */
  async verifyPurchaseTerms(quote: PaymentQuote): Promise<void> {
    await this.forService(quote.serviceType).verifyPurchaseTerms?.(quote);
  }
  /** Execute the selected category's already-claimed instruction once. */
  async submit(payment: ServicePayment): Promise<ProviderPaymentResult> {
    return this.forService(payment.quote.serviceType).submit(payment);
  }
  /** Recover through the original category's enquiry path, preserving its identity and accepted terms. */
  async lookup(payment: ServicePayment): Promise<ProviderPaymentResult> {
    return this.forService(payment.quote.serviceType).lookup(payment);
  }
  /** Unsupported service categories fail before entering any provider implementation. */
  private forService(serviceType: ServiceType): ServicePaymentProvider {
    const processor = this.processors.get(serviceType);
    if (!processor) {
      throw new PaymentError('PAYMENT_UNAVAILABLE', {
        reason: 'SERVICE_NOT_SUPPORTED',
      });
    }
    return processor;
  }
}
