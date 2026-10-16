import type { AxiosAdapter, AxiosInstance } from 'axios';
import {
  createOutboundHttpClient,
  OutboundHttpError,
} from '@axiapay/backend/infrastructure/http/axios-client';
import type { AuthenticationCodeDelivery } from '../ports/authentication.ports.js';

/** Capture both email and simulated SMS locally; this adapter never connects to a real SMS provider. */
export class MailpitAuthenticationCodeDelivery implements AuthenticationCodeDelivery {
  private readonly client: AxiosInstance;
  /** Accept only a loopback Mailpit endpoint so development codes cannot be routed to arbitrary hosts. */
  constructor(
    private readonly baseUrl: string,
    httpAdapter?: AxiosAdapter,
  ) {
    this.client = createOutboundHttpClient(10_000, httpAdapter);
    const url = new URL(baseUrl);
    if (
      url.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      throw new Error('Local code delivery requires a loopback Mailpit URL.');
    }
  }
  /** Capture the code with a finite timeout; rejection or uncertainty propagates to challenge invalidation. */
  async send(
    message: Parameters<AuthenticationCodeDelivery['send']>[0],
  ): Promise<void> {
    const recipient =
      message.contact.kind === 'email'
        ? message.contact.value
        : `sms+${message.contact.value.slice(1)}@sms.axiapay.test`;
    await this.client
      .request<string>({
        url: new URL('/api/v1/send', this.baseUrl).toString(),
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        data: JSON.stringify({
          From: {
            Email: 'authentication@axiapay.test',
            Name: 'AxiaPay local development',
          },
          To: [{ Email: recipient }],
          Subject: `AxiaPay ${message.purpose} code (${message.contact.kind})`,
          Text: `Your AxiaPay code is ${message.code}. It expires in ${message.expiresInSeconds / 60} minutes.\nRequest: ${message.challengeId}\nThis is local development delivery. Ignore this message if you did not request it.`,
          Tags: ['axiapay-auth', message.contact.kind],
        }),
      })
      .catch((error: unknown) => {
        if (
          error instanceof OutboundHttpError &&
          error.httpStatus !== undefined
        ) {
          throw new Error(
            `Local code delivery rejected with HTTP ${error.httpStatus}.`,
          );
        }
        throw new Error('Local code delivery failed or timed out.');
      });
  }
}
