import type { AxiosAdapter } from 'axios';
import { VtpassClient, type VtpassSettings } from './vtpass-client.js';
import {
  PaymentError,
  paymentTermsFingerprint,
  type ServicePayment,
} from '../domain/payment.js';
import type { ServiceProcessorAdapter } from '../ports/service-processor-adapter.js';
import type {
  PaymentTermsInput,
  ProviderPaymentResult,
} from '../ports/service-payment-provider.js';
import {
  serializeVtpassAirtime,
  vtpassMinorUnits,
  vtpassMovementId,
  formatVtpassNaira,
  isVtpassObject,
  supportsVtpassPhoneNumber,
  formatVtpassPhoneNumber,
  vtpassRequestId,
  type VtpassAirtimeRequest,
} from './vtpass-airtime.protocol.js';

/** Provisioned outbound settings; credentials never appear in first-party commands, catalogue rows or diagnostics. */
export type VtpassAirtimeSettings = VtpassSettings;

/** Explicit provider service identities from the documented domestic airtime APIs; retain historical product evidence metadata when withdrawing purchase support. No phone-prefix or fuzzy-name routing. */
const services: Readonly<
  Record<
    string,
    | {
        readonly networks: readonly string[];
        readonly productName: string;
      }
    | undefined
  >
> = Object.freeze({
  mtn: { networks: ['mtn'], productName: 'MTN Airtime VTU' },
  airtel: { networks: ['airtel'], productName: 'Airtel Airtime VTU' },
  glo: { networks: ['glo'], productName: 'GLO Airtime VTU' },
  etisalat: {
    networks: ['9mobile', 't2', 'etisalat'],
    productName: '9mobile Airtime VTU',
  },
});

/** VTpass domestic airtime translation, authenticated fixed-origin HTTP and correlated evidence. AxiaPay's processor owns sequencing; payment/wallet services own claims and financial rules. */
export class VtpassAirtimeAdapter implements ServiceProcessorAdapter<
  VtpassAirtimeRequest,
  Record<string, unknown>
> {
  readonly providerKey: string;
  private readonly client: VtpassClient;

  /** Inject immutable configuration and an optional deterministic transport for tests; production endpoints cannot be supplied by customers. */
  constructor(
    private readonly settings: VtpassAirtimeSettings,
    httpAdapter?: AxiosAdapter,
  ) {
    this.client = new VtpassClient(settings, httpAdapter);
    this.providerKey = settings.providerKey;
  }

  /** Check product, currency and recipient compatibility after the processor has checked service/account routing. No I/O or formatting occurs here. */
  validate(target: PaymentTermsInput): void {
    const { terms } = target;
    const currency =
      target.scope === 'quote'
        ? target.terms.principal.currency
        : target.terms.currency;
    if (currency !== 'NGN') {
      throw new PaymentError('PAYMENT_UNAVAILABLE', {
        reason: 'NGN_CURRENCY_REQUIRED',
      });
    }
    const service = Object.hasOwn(services, terms.providerProductCode)
      ? services[terms.providerProductCode]
      : undefined;
    if (!service) {
      throw new PaymentError('PAYMENT_UNAVAILABLE', {
        reason: 'PRODUCT_NOT_SUPPORTED',
      });
    }
    if (!service.networks.includes(terms.networkCode ?? '')) {
      throw new PaymentError('PAYMENT_UNAVAILABLE', {
        reason: 'NETWORK_PRODUCT_MISMATCH',
      });
    }
    if (target.scope === 'product') {
      return;
    }
    if (!target.terms.recipientPhoneNumber) {
      throw new PaymentError('INVALID_PAYMENT', {
        reason: 'RECIPIENT_REQUIRED',
      });
    }
    if (!supportsVtpassPhoneNumber(target.terms.recipientPhoneNumber)) {
      throw new PaymentError('INVALID_PAYMENT', {
        reason: 'NIGERIAN_RECIPIENT_REQUIRED',
      });
    }
  }

  /** Map already validated terms to the domestic request, using the saved claim timestamp and payment UUID as a restart-stable merchant identity. */
  toRequest(payment: ServicePayment): VtpassAirtimeRequest {
    return {
      request_id: vtpassRequestId(payment),
      serviceID: payment.quote.providerProductCode,
      amount: formatVtpassNaira(payment.quote.principal.amountMinorUnits),
      phone: formatVtpassPhoneNumber(payment.quote.recipientPhoneNumber!),
    };
  }

  /** Send one purchase with credentials scoped to the fixed environment; no internal retries or status-to-purchase fallback. */
  execute(request: VtpassAirtimeRequest): Promise<Record<string, unknown>> {
    return this.client.post('/api/pay', serializeVtpassAirtime(request));
  }

  /** Given the original validated instruction, only complete, correlated transaction evidence can resolve funds. Unknown/duplicate/not-found codes stay pending; API envelope success alone never confirms delivery. */
  toSubmission(
    response: Record<string, unknown>,
    payment: ServicePayment,
  ): ProviderPaymentResult {
    const identity = {
      paymentId: payment.id,
      termsFingerprint: paymentTermsFingerprint(payment),
    };
    const requestId = vtpassRequestId(payment);
    if (response.requestId !== undefined && response.requestId !== requestId) {
      throw new PaymentError('INVALID_PROVIDER_EVIDENCE', {
        reason: 'PROVIDER_REQUEST_MISMATCH',
      });
    }
    const content = response.content;
    if (!isVtpassObject(content) || !isVtpassObject(content.transactions)) {
      return { ...identity, outcome: 'pending' };
    }
    const transaction = content.transactions;
    const delivered =
      response.code === '000' && transaction.status === 'delivered';
    const failed =
      (response.code === '016' || response.code === '091') &&
      transaction.status === 'failed';
    const reversed =
      response.code === '040' && transaction.status === 'reversed';
    if (!delivered && !failed && !reversed) {
      return { ...identity, outcome: 'pending' };
    }
    // Any supplied reference matched above; final evidence additionally requires its presence.
    if (response.requestId === undefined) {
      throw new PaymentError('INVALID_PROVIDER_EVIDENCE', {
        reason: 'PROVIDER_REQUEST_MISMATCH',
      });
    }
    this.assertEvidence(payment, response, transaction, delivered);
    const movementId = vtpassMovementId(transaction.transactionId);
    const evidence = `vtpass:${this.settings.environment}:${movementId}`;
    if (delivered) {
      return {
        ...identity,
        outcome: 'succeeded',
        providerTransactionReference: movementId,
        evidenceReference: evidence,
      };
    }
    return {
      ...identity,
      outcome: 'failed',
      providerTransactionReference: movementId,
      evidenceReference: reversed
        ? `${evidence}:refund:${vtpassMovementId(transaction.wallet_credit_id, 'PROVIDER_REFUND_REFERENCE_INVALID')}`
        : evidence,
      fundsSafeToRelease: true,
    };
  }

  /** Enquire about accepted terms using the same saved identity even on another day; current purchase eligibility is irrelevant, while authenticated product/recipient/amount evidence remains required. */
  async lookup(payment: ServicePayment): Promise<ProviderPaymentResult> {
    const response = await this.client.post(
      '/api/requery',
      JSON.stringify({
        request_id: vtpassRequestId(payment),
      }),
    );
    return this.toSubmission(response, payment);
  }

  /** Check the true recipient field (unique_element, not merchant phone), exact principal and product proof. Reversal envelope amounts represent net partner refunds, not customer principal. */
  private assertEvidence(
    payment: ServicePayment,
    response: Record<string, unknown>,
    transaction: Record<string, unknown>,
    delivered: boolean,
  ): void {
    const quote = payment.quote;
    const { unique_element: recipient } = transaction;
    const allowedRecipients = [
      formatVtpassPhoneNumber(quote.recipientPhoneNumber!),
      quote.recipientPhoneNumber,
      quote.recipientPhoneNumber!.slice(1),
    ];
    if (
      typeof recipient !== 'string' ||
      !allowedRecipients.includes(recipient)
    ) {
      throw new PaymentError('INVALID_PROVIDER_EVIDENCE', {
        reason: 'PROVIDER_RECIPIENT_MISMATCH',
      });
    }
    if (
      vtpassMinorUnits(transaction.amount) !== quote.principal.amountMinorUnits
    ) {
      throw new PaymentError('INVALID_PROVIDER_EVIDENCE', {
        reason: 'PROVIDER_AMOUNT_MISMATCH',
      });
    }
    const expectedProduct = services[quote.providerProductCode]!.productName;
    if (
      (delivered || transaction.product_name !== undefined) &&
      transaction.product_name !== expectedProduct
    ) {
      throw new PaymentError('INVALID_PROVIDER_EVIDENCE', {
        reason: 'PROVIDER_PRODUCT_MISMATCH',
      });
    }
    if (!delivered) {
      return;
    }
    if (
      typeof transaction.type !== 'string' ||
      (transaction.type as string).toLowerCase() !== 'airtime recharge'
    ) {
      throw new PaymentError('INVALID_PROVIDER_EVIDENCE', {
        reason: 'PROVIDER_SERVICE_MISMATCH',
      });
    }
    if (transaction.quantity !== 1 && transaction.quantity !== '1') {
      throw new PaymentError('INVALID_PROVIDER_EVIDENCE', {
        reason: 'PROVIDER_QUANTITY_MISMATCH',
      });
    }
    if (
      vtpassMinorUnits(transaction.unit_price) !==
      quote.principal.amountMinorUnits
    ) {
      throw new PaymentError('INVALID_PROVIDER_EVIDENCE', {
        reason: 'PROVIDER_UNIT_PRICE_MISMATCH',
      });
    }
    if (
      vtpassMinorUnits(response.amount) !== quote.principal.amountMinorUnits
    ) {
      throw new PaymentError('INVALID_PROVIDER_EVIDENCE', {
        reason: 'PROVIDER_PURCHASE_AMOUNT_MISMATCH',
      });
    }
  }
}
