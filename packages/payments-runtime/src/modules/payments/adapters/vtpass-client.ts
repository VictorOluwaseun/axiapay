import type { AxiosAdapter, AxiosInstance } from 'axios';
import {
  createOutboundHttpClient,
  isOutboundResponseTooLarge,
  isOutboundTimeout,
  OutboundHttpError,
} from '../../../infrastructure/http/axios-client.js';
import { PaymentError } from '../domain/payment.js';
import { parseVtpassJson } from './vtpass-airtime.protocol.js';

/** Immutable credentials and route identity; GET and POST credentials never cross their respective authentication boundaries. */
export interface VtpassSettings {
  readonly environment: 'sandbox' | 'live';
  readonly providerKey: string;
  readonly apiKey: string;
  readonly secretKey: string;
  readonly publicKey?: string;
}

/** Fixed-origin VTpass JSON transport with safe bounded HTTP, no redirects or automatic retries. Business parsing stays in service adapters. */
export class VtpassClient {
  private readonly client: AxiosInstance;
  private readonly origin: string;
  /** Construct a private client; tests may replace transport without changing destinations or authentication policy. */
  constructor(
    private readonly settings: VtpassSettings,
    transport?: AxiosAdapter,
  ) {
    this.client = createOutboundHttpClient(8000, transport);
    this.origin =
      settings.environment === 'live'
        ? 'https://vtpass.com'
        : 'https://sandbox.vtpass.com';
  }
  /** POST one purchase, status enquiry or merchant verification; supplied bytes retain exact decimal amounts. */
  post(
    path: '/api/pay' | '/api/requery' | '/api/merchant-verify',
    body: string,
  ): Promise<Record<string, unknown>> {
    return this.request(path, 'POST', body);
  }
  /** Read authenticated variations, service metadata or insurance options without purchasing. Values are encoded as query parameters, never origins. */
  get(
    path:
      | '/api/service-variations'
      | '/api/services'
      | `/api/universal-insurance/options/${string}`,
    parameters: Readonly<Record<string, string>> = {},
  ): Promise<Record<string, unknown>> {
    if (!this.settings.publicKey) {
      throw new PaymentError('PAYMENT_UNAVAILABLE', {
        reason: 'PROVIDER_AUTHENTICATION_FAILED',
      });
    }
    return this.request(
      `${path}${Object.keys(parameters).length ? `?${new URLSearchParams(parameters)}` : ''}`,
      'GET',
    );
  }
  /** Normalize transport failures without retaining raw response bodies, credentials or exception messages. */
  private async request(
    path: string,
    method: 'GET' | 'POST',
    body?: string,
  ): Promise<Record<string, unknown>> {
    try {
      const response = await this.client.request<string>({
        url: `${this.origin}${path}`,
        method,
        headers: {
          'api-key': this.settings.apiKey,
          ...(method === 'POST'
            ? { 'secret-key': this.settings.secretKey }
            : { 'public-key': this.settings.publicKey }),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        data: body,
      });
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
      if (
        error instanceof OutboundHttpError &&
        error.httpStatus !== undefined
      ) {
        const reason = [401, 403].includes(error.httpStatus)
          ? 'PROVIDER_AUTHENTICATION_FAILED'
          : error.httpStatus === 429
            ? 'PROVIDER_RATE_LIMITED'
            : 'PROVIDER_HTTP_ERROR';
        throw new PaymentError('PAYMENT_UNAVAILABLE', { reason, cause: error });
      }
      if (isOutboundResponseTooLarge(error)) {
        throw new PaymentError('INVALID_PROVIDER_EVIDENCE', {
          reason: 'PROVIDER_RESPONSE_TOO_LARGE',
          cause: error,
        });
      }
      throw new PaymentError('PAYMENT_UNAVAILABLE', {
        reason: isOutboundTimeout(error)
          ? 'PROVIDER_TIMEOUT'
          : 'PROVIDER_CONNECTION_FAILED',
        cause: error instanceof OutboundHttpError ? error : undefined,
      });
    }
  }
}
