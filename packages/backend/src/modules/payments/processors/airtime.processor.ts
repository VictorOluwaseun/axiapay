import { PaymentError, type ServicePayment } from '../domain/payment.js';
import type { AirtimeProcessorAdapter } from '../ports/airtime-processor-adapter.js';
import type {
  PaymentTermsInput,
  ProviderPaymentResult,
  ServicePaymentProvider,
} from '../ports/service-payment-provider.js';

/** Own AxiaPay's stateless airtime request → execution → submission sequence. Payment services retain claiming, authorization, first-party result correlation, recovery and settlement; adapters own provider protocols. */
export class AirtimeProcessor<
  ProviderRequest,
  ProviderResponse,
> implements ServicePaymentProvider {
  /** Receive the provider adapter through the feature's composition factory; no SDK or framework enters this implementation. */
  constructor(
    private readonly adapter: AirtimeProcessorAdapter<
      ProviderRequest,
      ProviderResponse
    >,
  ) {}

  /** Delegate purchase validation to its single owner, retaining basic service and provider checks for adapters without a custom validator. */
  validate(target: PaymentTermsInput): void {
    if (this.adapter.validate) {
      this.adapter.validate(target);
      return;
    }

    this.validateProviderIdentity(target.terms);
  }

  /** Translate and submit an already-claimed airtime instruction once. Errors propagate unchanged so the caller retains uncertain progress and reconciles instead of replaying a purchase. */
  async submit(payment: ServicePayment): Promise<ProviderPaymentResult> {
    this.validate({ scope: 'quote', terms: payment.quote });
    const request = this.adapter.toRequest(payment);
    const response = await this.adapter.execute(request);
    return this.adapter.toSubmission(response, payment);
  }

  /** Check only the airtime/provider identity before enquiry; current purchase eligibility cannot block recovery of accepted terms. The adapter still authenticates evidence for the saved merchant identity. */
  async lookup(payment: ServicePayment): Promise<ProviderPaymentResult> {
    this.validateProviderIdentity(payment.quote);
    return this.adapter.lookup(payment);
  }

  /** Protect the adapter's service and account boundary without reapplying current product mappings or purchase encodings. */
  private validateProviderIdentity(terms: PaymentTermsInput['terms']): void {
    if (terms.serviceType !== 'airtime') {
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
