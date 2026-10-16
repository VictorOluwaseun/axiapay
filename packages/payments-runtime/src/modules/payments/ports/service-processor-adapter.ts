import type { ServicePayment } from '../domain/payment.js';
import type {
  PaymentTermsInput,
  ProviderPaymentResult,
} from './service-payment-provider.js';

/** Provider protocol behind a first-party service processor. Implementations own wire mapping, authentication and evidence; payment services own authorization, claims and settlement. */
export interface ServiceProcessorAdapter<ProviderRequest, ProviderResponse> {
  /** Immutable provider account/environment route, retained while accepted obligations remain unresolved. */
  readonly providerKey: string;
  /** Optional pure protocol compatibility check for trusted terms. The processor owns service/account routing before this call; never repeat request DTO validation, perform I/O or run during lookup. */
  validate?(target: PaymentTermsInput): void;
  /** Observe current external terms for an already protocol-validated quote, without repeating static checks or purchasing. The processor owns validation before this call; existing-hold recovery bypasses it. */
  verifyPurchaseTerms?(
    quote: import('../domain/payment.js').PaymentQuote,
  ): Promise<void>;
  /** Map persisted accepted terms without I/O or a new logical request identity. */
  toRequest(payment: ServicePayment): ProviderRequest;
  /** Execute the original purchase once with bounded transport and no blind retries. */
  execute(request: ProviderRequest): Promise<ProviderResponse>;
  /** Authenticate and correlate provider evidence before returning a first-party observation. This mapping performs no I/O. */
  toSubmission(
    response: ProviderResponse,
    payment: ServicePayment,
  ): ProviderPaymentResult;
  /** Query the original instruction without purchasing or reapplying current purchase eligibility. */
  lookup(payment: ServicePayment): Promise<ProviderPaymentResult>;
}
