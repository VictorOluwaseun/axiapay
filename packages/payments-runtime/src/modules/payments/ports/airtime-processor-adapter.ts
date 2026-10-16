import type { ServicePayment } from '../domain/payment.js';
import type {
  PaymentTermsInput,
  ProviderPaymentResult,
} from './service-payment-provider.js';

/** Provider-specific airtime protocol plugged into AxiaPay's shared processor. Wire types stay inside the adapter/composition boundary; this capability never owns wallet authorization or settlement. */
export interface AirtimeProcessorAdapter<ProviderRequest, ProviderResponse> {
  /** Immutable deployment routing key, including the provider account/environment; it must match the accepted quote. */
  readonly providerKey: string;

  /** Optional pure purchase validator for category, account routing and provider encodings. Product input lacks recipient details; quote input additionally checks those details. Throws before a new hold and is never invoked by lookup. */
  validate?(target: PaymentTermsInput): void;

  /** Translate already validated terms using payment.id as the logical merchant identity, preserving exact money and the explicitly selected network. Protocol encodings must be deterministic from persisted terms; no network I/O or new logical identity. */
  toRequest(payment: ServicePayment): ProviderRequest;

  /** Send one purchase with bounded transport timeouts. Preserve errors and uncertainty; never blindly retry or turn a timeout into a final failed payment. */
  execute(request: ProviderRequest): Promise<ProviderResponse>;

  /** Authenticate, validate and correlate upstream evidence with the original instruction before producing our result. Acceptance alone is pending; this method performs no network I/O. */
  toSubmission(
    response: ProviderResponse,
    payment: ServicePayment,
  ): ProviderPaymentResult;

  /** Enquire about previously accepted terms using the saved merchant identity without initiating a purchase or reapplying current purchase eligibility. Own enquiry-specific requirements, authentication and evidence correlation; retain historical protocol support for unresolved obligations. */
  lookup(payment: ServicePayment): Promise<ProviderPaymentResult>;
}
