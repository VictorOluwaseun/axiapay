import type { AxiosAdapter, AxiosInstance } from 'axios';
import { createOutboundHttpClient } from '@axiapay/backend/infrastructure/http/axios-client';
import { createHmac } from 'node:crypto';
import type {
  FundingAdapter,
  FundingNotification,
  FundingCheckoutRequest,
} from '../ports/funding-adapter.js';
import {
  FundingError,
  type FundingEnvironment,
  type VerifiedFundingPayment,
} from '../domain/funding.js';
import { money } from '@axiapay/backend/modules/wallets/domain/money';
import {
  parsePartnerJson,
  partnerCheckoutUrl,
  partnerInteger,
  partnerMovementId,
  partnerObject,
  partnerString,
  requestPartnerJson,
} from './partner-http.js';
import { verifyPartnerSignature } from './partner-signature.js';

/** OPay Nigeria Express Checkout adapter; callback SHA3 signatures intentionally differ from API request SHA512 signatures. */
export class OpayFundingGateway implements FundingAdapter {
  private readonly client: AxiosInstance;
  /** Credentials and return/webhook URLs are deployment configuration, never client input. */
  constructor(
    readonly environment: FundingEnvironment,
    readonly partnerAccountId: string,
    private readonly merchantId: string,
    private readonly publicKey: string,
    private readonly secret: string,
    private readonly returnUrl: string,
    private readonly webhookUrl: string,
    httpAdapter?: AxiosAdapter,
  ) {
    this.client = createOutboundHttpClient(8000, httpAdapter);
  }

  /** Create hosted checkout for the immutable intent; card and bank credentials stay on OPay's page. */
  async initialize(request: FundingCheckoutRequest): Promise<string> {
    // OPay's JSON amount is an integer token. The registered option advertises this limit; guard again before encoding.
    if (request.value.amountMinorUnits > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new FundingError('INVALID_FUNDING');
    }
    const body = JSON.stringify({
      amount: {
        currency: request.value.currency,
        total: Number(request.value.amountMinorUnits),
      },
      callbackUrl: this.webhookUrl,
      country: 'NG',
      customerVisitSource: 'BROWSER',
      product: {
        name: 'AxiaPay wallet funding',
        description: 'Add money to an AxiaPay wallet',
      },
      reference: request.reference,
      returnUrl: this.returnUrl,
      userInfo: { userEmail: request.payerEmail },
    });
    const payment = await this.call('create', body, this.publicKey);
    if (payment.reference !== request.reference) {
      throw new FundingError('INVALID_FUNDING');
    }
    const amount = partnerObject(payment.amount);
    if (
      partnerInteger(amount.total) !== request.value.amountMinorUnits ||
      amount.currency !== request.value.currency
    ) {
      throw new FundingError('INVALID_FUNDING');
    }
    return partnerCheckoutUrl(payment.cashierUrl, 'opay');
  }

  /** Query the configured Nigeria merchant directly with alphabetically ordered signed request keys. */
  async verify(reference: string): Promise<VerifiedFundingPayment> {
    const body = JSON.stringify({ country: 'NG', reference });
    const signature = createHmac('sha512', this.secret)
      .update(body)
      .digest('hex');
    const payment = await this.call('status', body, signature);
    const amount = partnerObject(payment.amount);
    if (
      payment.isVoided !== undefined &&
      typeof payment.isVoided !== 'boolean'
    ) {
      throw new FundingError('INVALID_FUNDING');
    }
    return {
      reference: partnerString(payment.reference),
      externalMovementId: partnerMovementId(payment.orderNo),
      value: money(
        partnerInteger(amount.total),
        partnerString(amount.currency),
      ),
      isSuccessful: payment.status === 'SUCCESS' && payment.isVoided !== true,
    };
  }

  /** Verify OPay's documented ordered callback representation, including the t/f refund flag, before trusting any identity. */
  authenticateNotification(rawBody: Uint8Array): FundingNotification | null {
    const event = partnerObject(
      parsePartnerJson(Buffer.from(rawBody).toString('utf8')),
    );
    const payload = partnerObject(event.payload);
    const fields = [
      'amount',
      'currency',
      'reference',
      'status',
      'timestamp',
      'transactionId',
    ] as const;
    const values = Object.fromEntries(
      fields.map((field) => [field, partnerString(payload[field])]),
    );
    const token =
      payload.token === null ||
      payload.token === undefined ||
      payload.token === ''
        ? ''
        : partnerString(payload.token);
    if (typeof payload.refunded !== 'boolean') {
      throw new FundingError('INVALID_WEBHOOK');
    }
    // Delimiters must not be injectable into OPay's non-JSON signing representation.
    if (
      [...Object.values(values), token].some((value) => /["\\\r\n]/.test(value))
    ) {
      throw new FundingError('INVALID_WEBHOOK');
    }
    const content = `{Amount:"${values.amount}",Currency:"${values.currency}",Reference:"${values.reference}",Refunded:${payload.refunded ? 't' : 'f'},Status:"${values.status}",Timestamp:"${values.timestamp}",Token:"${token}",TransactionID:"${values.transactionId}"}`;
    verifyPartnerSignature('sha3-512', this.secret, content, event.sha512);
    if (
      event.type !== 'transaction-status' ||
      payload.status !== 'SUCCESS' ||
      payload.refunded
    ) {
      return null;
    }
    return {
      reference: values.reference!,
      externalMovementId: partnerMovementId(values.transactionId),
    };
  }

  /** Choose the documented Nigeria host from the environment; never permit caller-controlled provider URLs. */
  private async call(
    action: 'create' | 'status',
    body: string,
    authorization: string,
  ): Promise<Record<string, unknown>> {
    const host =
      this.environment === 'test'
        ? 'testapi.opaycheckout.com'
        : 'liveapi.opaycheckout.com';
    const result = await requestPartnerJson(
      this.client,
      `https://${host}/api/v1/international/cashier/${action}`,
      {
        method: 'POST',
        data: body,
        headers: {
          Authorization: `Bearer ${authorization}`,
          MerchantId: this.merchantId,
          'Content-Type': 'application/json',
        },
      },
    );
    if (result.code !== '00000') {
      throw new FundingError('FUNDING_UNAVAILABLE');
    }
    return partnerObject(result.data);
  }
}
