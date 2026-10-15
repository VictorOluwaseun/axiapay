import type { AxiosAdapter, AxiosInstance, AxiosRequestConfig } from 'axios';
import { createOutboundHttpClient } from '../../../infrastructure/http/axios-client.js';
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
import { money } from '../../wallets/domain/money.js';
import {
  parsePartnerJson,
  partnerCheckoutUrl,
  partnerInteger,
  partnerObject,
  partnerString,
  requestPartnerJson,
} from './partner-http.js';
import { verifyPartnerSignature } from './partner-signature.js';

/** Paystack hosted checkout, raw-body HMAC-SHA512 webhooks, and server-authenticated transaction verification. */
export class PaystackFundingGateway implements FundingAdapter {
  private readonly client: AxiosInstance;
  /** The secret's test/live scope is validated by composition; ledger account identity is never supplied by customers. */
  constructor(
    readonly environment: FundingEnvironment,
    readonly partnerAccountId: string,
    private readonly secret: string,
    private readonly returnUrl: string,
    httpAdapter?: AxiosAdapter,
  ) {
    this.client = createOutboundHttpClient(8000, httpAdapter);
  }

  /** Initialize exactly the persisted reference; the client never calls Paystack with the secret key. */
  async initialize(request: FundingCheckoutRequest): Promise<string> {
    const result = await this.call('/transaction/initialize', {
      method: 'POST',
      data: JSON.stringify({
        reference: request.reference,
        email: request.payerEmail,
        amount: request.value.amountMinorUnits.toString(),
        currency: request.value.currency,
        callback_url: this.returnUrl,
      }),
    });
    const payment = partnerObject(result.data);
    if (payment.reference !== request.reference) {
      throw new FundingError('INVALID_FUNDING');
    }
    return partnerCheckoutUrl(payment.authorization_url, 'paystack');
  }

  /** Require transaction-level success in the correct environment, not the API envelope's status flag. */
  async verify(reference: string): Promise<VerifiedFundingPayment> {
    const result = await this.call(
      `/transaction/verify/${encodeURIComponent(reference)}`,
      { method: 'GET' },
    );
    const payment = partnerObject(result.data);
    if (payment.domain !== this.environment) {
      throw new FundingError('INVALID_FUNDING');
    }
    return {
      reference: partnerString(payment.reference),
      externalMovementId: partnerInteger(payment.id).toString(),
      value: money(
        partnerInteger(payment.amount),
        partnerString(payment.currency),
      ),
      isSuccessful: payment.status === 'success',
    };
  }

  /** Verify the exact received bytes before interpreting charge.success; metadata never chooses the wallet. */
  authenticateNotification(
    rawBody: Uint8Array,
    signature: string | undefined,
  ): FundingNotification | null {
    verifyPartnerSignature('sha512', this.secret, rawBody, signature);
    const event = partnerObject(
      parsePartnerJson(Buffer.from(rawBody).toString('utf8')),
    );
    if (event.event !== 'charge.success') {
      return null;
    }
    const payment = partnerObject(event.data);
    if (payment.domain !== this.environment) {
      throw new FundingError('INVALID_WEBHOOK');
    }
    return {
      reference: partnerString(payment.reference),
      externalMovementId: partnerInteger(payment.id).toString(),
    };
  }

  /** Keep credentials on the fixed Paystack origin; transport errors never reveal headers or response bodies. */
  private async call(
    path: string,
    options: Pick<AxiosRequestConfig<string>, 'method' | 'data'>,
  ): Promise<Record<string, unknown>> {
    const result = await requestPartnerJson(
      this.client,
      `https://api.paystack.co${path}`,
      {
        ...options,
        headers: {
          Authorization: `Bearer ${this.secret}`,
          'Content-Type': 'application/json',
        },
      },
    );
    if (result.status !== true) {
      throw new FundingError('FUNDING_UNAVAILABLE');
    }
    return result;
  }
}
