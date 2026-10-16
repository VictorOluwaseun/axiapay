import type { AxiosAdapter } from 'axios';
import {
  PaymentError,
  type PaymentQuote,
  type ServicePayment,
} from '../domain/payment.js';
import type { ServiceProcessorAdapter } from '../ports/service-processor-adapter.js';
import type {
  PaymentTermsInput,
  ProviderPaymentResult,
} from '../ports/service-payment-provider.js';
import type { PaymentFulfilment } from '../domain/payment-fulfilment.js';
import {
  formatVtpassNaira,
  formatVtpassPhoneNumber,
  vtpassRequestId,
  supportsVtpassPhoneNumber,
} from './vtpass-airtime.protocol.js';
import { VtpassClient, type VtpassSettings } from './vtpass-client.js';
import {
  assertVtpassVariationPrice,
  serializeVtpassPurchase,
  vtpassProductSelection,
  vtpassTransactionResult,
  type VtpassPurchaseRequest,
} from './vtpass-purchase.protocol.js';
import type { VtpassServiceProfile } from './vtpass-service-profiles.js';

/** Shared VTpass protocol mechanics, reused only where their documented request and transaction envelopes coincide. Category adapters own recipients, prerequisites and receipts. */
export abstract class VtpassServiceAdapter implements ServiceProcessorAdapter<
  VtpassPurchaseRequest,
  Record<string, unknown>
> {
  readonly providerKey: string;
  private readonly profiles: Readonly<Record<string, VtpassServiceProfile>>;
  protected readonly client: VtpassClient;
  /** Bind fixed provider account/environment settings and a reviewed category map; constructing an adapter performs no network I/O. */
  constructor(
    protected readonly settings: VtpassSettings,
    profiles: Readonly<Record<string, VtpassServiceProfile>>,
    transport?: AxiosAdapter,
  ) {
    this.profiles = Object.freeze(
      Object.fromEntries(
        Object.entries(profiles).map(([code, profile]) => [
          code,
          Object.freeze({
            ...profile,
            productNames: Object.freeze([...profile.productNames]),
            networks: profile.networks
              ? Object.freeze([...profile.networks])
              : undefined,
            billerCodes: profile.billerCodes
              ? Object.freeze([...profile.billerCodes])
              : undefined,
          }),
        ]),
      ),
    );
    this.providerKey = settings.providerKey;
    this.client = new VtpassClient(settings, transport);
  }
  /** Check protocol compatibility after service/account routing; non-purchasing capabilities select their account from the trusted product. Full quotes additionally require a Nigerian contact. */
  validate(target: PaymentTermsInput): void {
    const terms = target.terms;
    const currency =
      target.scope === 'quote'
        ? target.terms.principal.currency
        : target.terms.currency;
    if (currency !== 'NGN') {
      throw new PaymentError('PAYMENT_UNAVAILABLE', {
        reason: 'NGN_CURRENCY_REQUIRED',
      });
    }
    const profile = this.profile(terms.providerProductCode);
    if (profile.requiresVariation && !this.settings.publicKey) {
      throw new PaymentError('PAYMENT_UNAVAILABLE', {
        reason: 'PROVIDER_AUTHENTICATION_FAILED',
      });
    }
    if (
      profile.networks &&
      !profile.networks.includes(terms.networkCode ?? '')
    ) {
      throw new PaymentError('PAYMENT_UNAVAILABLE', {
        reason: 'NETWORK_PRODUCT_MISMATCH',
      });
    }
    if (
      profile.billerCodes &&
      !profile.billerCodes.includes(terms.billerCode ?? '')
    ) {
      throw new PaymentError('PAYMENT_UNAVAILABLE', {
        reason: 'PRODUCT_NOT_SUPPORTED',
      });
    }
    this.validateService(target);
    if (target.scope === 'product') {
      return;
    }
    const contactPhoneNumber = this.contactPhone(target.terms);
    if (!contactPhoneNumber || !supportsVtpassPhoneNumber(contactPhoneNumber)) {
      throw new PaymentError('INVALID_PAYMENT', {
        reason: 'NIGERIAN_RECIPIENT_REQUIRED',
      });
    }
  }
  /** Recheck current fixed-plan price before review or a fresh wallet hold. Held obligations bypass this operation during recovery. */
  async verifyPurchaseTerms(quote: PaymentQuote): Promise<void> {
    const selection = vtpassProductSelection(quote.providerProductCode);
    if (selection.variationCode === undefined) {
      return;
    }
    const response = await this.client.get('/api/service-variations', {
      serviceID: selection.serviceId,
    });
    assertVtpassVariationPrice(response, quote, selection);
  }
  /** Translate accepted immutable terms; fixed plans omit amount where VTpass uses variation pricing instead of a top-up amount. */
  toRequest(payment: ServicePayment): VtpassPurchaseRequest {
    const { serviceId, variationCode } = vtpassProductSelection(
      payment.quote.providerProductCode,
    );
    return {
      request_id: vtpassRequestId(payment),
      serviceID: serviceId,
      phone: formatVtpassPhoneNumber(this.contactPhone(payment.quote)!),
      variation_code: variationCode,
      ...this.requestFields(payment, serviceId),
    };
  }
  /** Send one purchase without retrying uncertainty or substituting a lookup with another purchase. */
  execute(request: VtpassPurchaseRequest): Promise<Record<string, unknown>> {
    return this.client.post('/api/pay', serializeVtpassPurchase(request));
  }
  /** Validate financial evidence before interpreting optional service receipts. A missing receipt remains recoverable under the original request. */
  toSubmission(
    response: Record<string, unknown>,
    payment: ServicePayment,
  ): ProviderPaymentResult {
    const profile = this.profile(payment.quote.providerProductCode);
    const result = vtpassTransactionResult(this.settings, response, payment, {
      productNames: profile.productNames,
      transactionType: profile.transactionType,
      recipients: this.recipients(payment),
    });
    if (result.outcome !== 'succeeded') {
      return result;
    }
    const fulfilment = this.receipt(
      response,
      payment,
      result.providerTransactionReference,
    );
    return fulfilment ? { ...result, fulfilment } : result;
  }
  /** Enquire only about the persisted request; current plan prices and purchase eligibility never gate an existing obligation. */
  async lookup(payment: ServicePayment): Promise<ProviderPaymentResult> {
    const response = await this.client.post(
      '/api/requery',
      JSON.stringify({ request_id: vtpassRequestId(payment) }),
    );
    return this.toSubmission(response, payment);
  }
  /** Retain reviewed historical evidence metadata even when catalogue publication is withdrawn. */
  protected profile(code: string): VtpassServiceProfile {
    if (
      !/^[a-z0-9][a-z0-9-]{0,69}(?::[A-Za-z0-9][A-Za-z0-9._-]{0,119})?(?![\s\S])/.test(
        code,
      )
    ) {
      throw new PaymentError('PAYMENT_UNAVAILABLE', {
        reason: 'PRODUCT_NOT_SUPPORTED',
      });
    }
    const { serviceId, variationCode } = vtpassProductSelection(code);
    const profile = Object.hasOwn(this.profiles, serviceId)
      ? this.profiles[serviceId]
      : undefined;
    if (
      !profile ||
      profile.requiresVariation !== (variationCode !== undefined)
    ) {
      throw new PaymentError('PAYMENT_UNAVAILABLE', {
        reason: 'PRODUCT_NOT_SUPPORTED',
      });
    }
    return profile;
  }
  /** Select the already validated contact without repeating protocol checks during request mapping. */
  protected contactPhone(quote: PaymentQuote): string | undefined {
    return (
      quote.contactPhoneNumber ??
      quote.recipientPhoneNumber ??
      quote.insuranceApplication?.insuredProfile.phoneNumber
    );
  }
  /** Format a variable payment's accepted principal without floating-point arithmetic. */
  protected amount(payment: ServicePayment): string {
    return formatVtpassNaira(payment.quote.principal.amountMinorUnits);
  }
  /** Category-specific pure purchase compatibility rules. */
  protected abstract validateService(target: PaymentTermsInput): void;
  /** Category-specific wire fields; implementations must not perform I/O here. */
  protected abstract requestFields(
    payment: ServicePayment,
    serviceId: string,
  ): Readonly<Record<string, string | undefined>>;
  /** Exact recipient identities accepted in authenticated final evidence; contact phone is not automatically the recipient. */
  protected abstract recipients(payment: ServicePayment): readonly string[];
  /** Optional complete receipt projection; absence is distinct from financial failure. */
  protected receipt(
    _response: Record<string, unknown>,
    _payment: ServicePayment,
    _reference: string,
  ): PaymentFulfilment | undefined {
    void [_response, _payment, _reference];
    return undefined;
  }
}
