import type { AuthenticationCodeDelivery } from '../ports/authentication.ports.js';

/** Capture both email and simulated SMS locally; this adapter never connects to a real SMS provider. */
export class MailpitAuthenticationCodeDelivery implements AuthenticationCodeDelivery {
  /** Accept only a loopback Mailpit endpoint so development codes cannot be routed to arbitrary hosts. */
  constructor(private readonly baseUrl: string) {
    const url = new URL(baseUrl);
    if (
      url.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error('Local code delivery requires a loopback Mailpit URL.');
  }
  /** Capture the code with a finite timeout; rejection or uncertainty propagates to challenge invalidation. */
  async send(
    message: Parameters<AuthenticationCodeDelivery['send']>[0],
  ): Promise<void> {
    const recipient =
      message.contact.kind === 'email'
        ? message.contact.value
        : `sms+${message.contact.value.slice(1)}@sms.axiapay.test`;
    const response = await fetch(new URL('/api/v1/send', this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        From: {
          Email: 'authentication@axiapay.test',
          Name: 'AxiaPay local development',
        },
        To: [{ Email: recipient }],
        Subject: `AxiaPay ${message.purpose} code (${message.contact.kind})`,
        Text: `Your AxiaPay code is ${message.code}. It expires in ${message.expiresInSeconds / 60} minutes.\nRequest: ${message.challengeId}\nThis is local development delivery. Ignore this message if you did not request it.`,
        Tags: ['axiapay-auth', message.contact.kind],
      }),
    });
    if (!response.ok)
      throw new Error(
        `Local code delivery rejected with HTTP ${response.status}.`,
      );
  }
}
