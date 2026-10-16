import type { AxiosAdapter, AxiosInstance } from 'axios';
import {
  createOutboundHttpClient,
  isOutboundResponseTooLarge,
  isOutboundTimeout,
} from '../../../infrastructure/http/axios-client.js';
import {
  PaymentError,
  paymentTermsFingerprint,
  type ServicePayment,
} from '../domain/payment.js';
import type { PaymentErrorReason } from '../domain/payment-error-reasons.js';
import type { AirtimeProcessorAdapter } from '../ports/airtime-processor-adapter.js';
import type {
  PaymentTermsInput,
  ProviderPaymentResult,
} from '../ports/service-payment-provider.js';
import {
  parseVtpassJson,
  serializeVtpassAirtime,
  vtpassMinorUnits,
  vtpassMovementId,
  formatVtpassNaira,
  vtpassObject,
  formatVtpassPhoneNumber,
  vtpassRequestId,
  type VtpassAirtimeRequest,
} from './vtpass-airtime.protocol.js';

/** Provisioned outbound settings; credentials never appear in first-party commands, catalogue rows or diagnostics. */
export interface VtpassAirtimeSettings {
  readonly environment: 'sandbox' | 'live';
  readonly providerKey: string;
  readonly apiKey: string;
  readonly secretKey: string;
}

/** Explicit provider service identities from the documented domestic airtime APIs; no phone-prefix or fuzzy-name routing. */
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

/** Classify HTTP failures without exposing upstream bodies, headers or transport exception messages. */
function vtpassHttpFailureReason(status: number): PaymentErrorReason {
  if (status === 401 || status === 403) {
    return 'PROVIDER_AUTHENTICATION_FAILED';
  }
  if (status === 429) {
    return 'PROVIDER_RATE_LIMITED';
  }
  return 'PROVIDER_HTTP_ERROR';
}

/** VTpass domestic airtime translation, authenticated fixed-origin HTTP and correlated evidence. AxiaPay's processor owns sequencing; payment/wallet services own claims and financial rules. */
export class VtpassAirtimeAdapter implements AirtimeProcessorAdapter<
  VtpassAirtimeRequest,
  Record<string, unknown>
> {
  readonly providerKey: string;
  private readonly origin: string;
  private readonly client: AxiosInstance;

  /** Inject immutable configuration and an optional deterministic transport for tests; production endpoints cannot be supplied by customers. */
  constructor(
    private readonly settings: VtpassAirtimeSettings,
    httpAdapter?: AxiosAdapter,
  ) {
    this.client = createOutboundHttpClient(8000, httpAdapter);
    this.providerKey = settings.providerKey;
    this.origin =
      settings.environment === 'live'
        ? 'https://vtpass.com'
        : 'https://sandbox.vtpass.com';
  }

  /** Assert provider compatibility before processing. Products and quotes share routing/product/currency checks; full quotes additionally require a representable recipient. This method performs no I/O or formatting. */
  validate(target: PaymentTermsInput): void {
    const { terms } = target;
    if (terms.serviceType !== 'airtime') {
      throw new PaymentError('PAYMENT_UNAVAILABLE', {
        reason: 'SERVICE_NOT_SUPPORTED',
      });
    }
    if (terms.providerKey !== this.providerKey) {
      throw new PaymentError('PAYMENT_UNAVAILABLE', {
        reason: 'PROVIDER_ROUTE_MISMATCH',
      });
    }
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
    if (
      !/^\+234[1-9][0-9]{9}(?![\s\S])/.test(target.terms.recipientPhoneNumber)
    ) {
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
    return this.call('/api/pay', serializeVtpassAirtime(request));
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
    if (
      typeof content !== 'object' ||
      content === null ||
      Array.isArray(content)
    ) {
      return { ...identity, outcome: 'pending' };
    }
    const transactions = (content as Record<string, unknown>).transactions;
    if (
      typeof transactions !== 'object' ||
      transactions === null ||
      Array.isArray(transactions)
    ) {
      return { ...identity, outcome: 'pending' };
    }
    const transaction = vtpassObject(transactions);
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

  /** Enquire about a validated instruction using the same saved identity even on another day; never call the purchase endpoint. */
  async lookup(payment: ServicePayment): Promise<ProviderPaymentResult> {
    const response = await this.call(
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
    const recipient = transaction.unique_element;
    const allowedRecipients = [
      formatVtpassPhoneNumber(quote.recipientPhoneNumber!),
      quote.recipientPhoneNumber,
      quote.recipientPhoneNumber!.slice(1),
    ];
    if (response.requestId !== vtpassRequestId(payment)) {
      throw new PaymentError('INVALID_PROVIDER_EVIDENCE', {
        reason: 'PROVIDER_REQUEST_MISMATCH',
      });
    }
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
      (transaction.product_name !== undefined &&
        transaction.product_name !== expectedProduct) ||
      (transaction.serviceID !== undefined &&
        transaction.serviceID !== quote.providerProductCode)
    ) {
      throw new PaymentError('INVALID_PROVIDER_EVIDENCE', {
        reason: 'PROVIDER_PRODUCT_MISMATCH',
      });
    }
    if (transaction.currency !== undefined && transaction.currency !== 'NGN') {
      throw new PaymentError('INVALID_PROVIDER_EVIDENCE', {
        reason: 'PROVIDER_CURRENCY_MISMATCH',
      });
    }
    if (!delivered) {
      return;
    }
    if (transaction.product_name !== expectedProduct) {
      throw new PaymentError('INVALID_PROVIDER_EVIDENCE', {
        reason: 'PROVIDER_PRODUCT_MISMATCH',
      });
    }
    if (transaction.type !== 'Airtime Recharge') {
      throw new PaymentError('INVALID_PROVIDER_EVIDENCE', {
        reason: 'PROVIDER_SERVICE_MISMATCH',
      });
    }
    if (transaction.quantity !== '1') {
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

  /** POST once with an eight-second deadline, rejected redirects, decoded response size cap and safe diagnostics; response bodies and credentials never enter errors. */
  private async call(
    path: '/api/pay' | '/api/requery',
    body: string,
  ): Promise<Record<string, unknown>> {
    try {
      const response = await this.client.request<string>({
        url: `${this.origin}${path}`,
        method: 'POST',
        headers: {
          'api-key': this.settings.apiKey,
          'secret-key': this.settings.secretKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        data: body,
        signal: AbortSignal.timeout(8000),
      });
      if (response.status < 200 || response.status >= 300) {
        throw new PaymentError('PAYMENT_UNAVAILABLE', {
          reason: vtpassHttpFailureReason(response.status),
          cause: new Error(`VTpass HTTP status ${response.status}`),
        });
      }
      if (response.data.length === 0) {
        throw new PaymentError('INVALID_PROVIDER_EVIDENCE', {
          reason: 'PROVIDER_RESPONSE_EMPTY',
        });
      }
      return parseVtpassJson(response.data);
    } catch (error) {
      if (error instanceof PaymentError) {
        throw error;
      }
      if (isOutboundResponseTooLarge(error)) {
        throw new PaymentError('INVALID_PROVIDER_EVIDENCE', {
          reason: 'PROVIDER_RESPONSE_TOO_LARGE',
        });
      }
      const reason = isOutboundTimeout(error)
        ? 'PROVIDER_TIMEOUT'
        : 'PROVIDER_CONNECTION_FAILED';
      throw new PaymentError('PAYMENT_UNAVAILABLE', {
        reason,
      });
    }
  }
}
