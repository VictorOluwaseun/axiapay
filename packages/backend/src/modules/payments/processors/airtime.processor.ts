import {
  PaymentError,
  paymentTermsFingerprint,
  type ServicePayment,
} from '../domain/payment.js';
import type { AirtimeProcessorAdapter } from '../ports/airtime-processor-adapter.js';
import type {
  PaymentTermsInput,
  ProviderPaymentResult,
  ServicePaymentProvider,
} from '../ports/service-payment-provider.js';

/** Own AxiaPay's stateless airtime request → execution → submission sequence. Payment services retain durable claiming, authorization, recovery and wallet settlement; adapters own provider protocols. */
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

  /** Delegate protocol validation to its single owner, retaining basic airtime routing guards for adapters without a custom validator. */
  validate(target: PaymentTermsInput): void {
    if (this.adapter.validate) {
      this.adapter.validate(target);
      return;
    }
    this.assertRouting(target);
  }

  /** Translate and submit an already-claimed airtime instruction once. Errors propagate unchanged so the caller retains uncertain progress and reconciles instead of replaying a purchase. */
  async submit(payment: ServicePayment): Promise<ProviderPaymentResult> {
    this.validate({ scope: 'quote', terms: payment.quote });
    const request = this.adapter.toRequest(payment);
    const response = await this.adapter.execute(request);
    return this.correlatedSubmission(
      payment,
      this.adapter.toSubmission(response, payment),
    );
  }

  /** Enquire through the injected adapter only; lookup never enters the purchase pipeline or creates another merchant identity. */
  async lookup(payment: ServicePayment): Promise<ProviderPaymentResult> {
    this.validate({ scope: 'quote', terms: payment.quote });
    return this.correlatedSubmission(
      payment,
      await this.adapter.lookup(payment),
    );
  }

  /** Refuse another service type or a changed provider account/environment before any provider method runs. */
  private assertRouting(quote: PaymentTermsInput): void {
    if (quote.terms.serviceType !== 'airtime') {
      throw new PaymentError('INVALID_PAYMENT', {
        reason: 'SERVICE_NOT_SUPPORTED',
      });
    }
    if (quote.terms.providerKey !== this.adapter.providerKey) {
      throw new PaymentError('PAYMENT_UNAVAILABLE', {
        reason: 'PROVIDER_ROUTE_MISMATCH',
      });
    }
  }

  /** Check first-party identity/terms without claiming to authenticate upstream evidence; that remains the adapter's responsibility. */
  private correlatedSubmission(
    payment: ServicePayment,
    result: ProviderPaymentResult,
  ): ProviderPaymentResult {
    if (result.paymentId !== payment.id) {
      throw new PaymentError('INVALID_PROVIDER_EVIDENCE', {
        reason: 'PAYMENT_ID_MISMATCH',
      });
    }
    if (result.termsFingerprint !== paymentTermsFingerprint(payment)) {
      throw new PaymentError('INVALID_PROVIDER_EVIDENCE', {
        reason: 'PAYMENT_TERMS_MISMATCH',
      });
    }
    return result;
  }
}
