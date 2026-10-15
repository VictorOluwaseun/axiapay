/** Verify the local email and simulated SMS adapters against a real disposable Mailpit server. */
import axios from 'axios';
import { describe, expect, it } from 'vitest';
import { GenericContainer } from 'testcontainers';
import { MailpitAuthenticationCodeDelivery } from '../../src/modules/authentication/providers/mailpit-authentication-code-delivery.js';

describe('local authentication delivery', () => {
  it('captures email and simulated SMS without returning secrets through an application endpoint', async () => {
    const container = await new GenericContainer('axllent/mailpit:v1.31.5')
      .withExposedPorts(8025)
      .start();
    try {
      const baseUrl = `http://${container.getHost()}:${container.getMappedPort(8025)}`;
      const delivery = new MailpitAuthenticationCodeDelivery(baseUrl);
      await delivery.send({
        contact: { kind: 'email', value: 'alice@example.com' },
        purpose: 'signup',
        code: '012345',
        challengeId: 'email-test',
        expiresInSeconds: 300,
      });
      await delivery.send({
        contact: { kind: 'phone', value: '+2348012345678' },
        purpose: 'login',
        code: '543210',
        challengeId: 'sms-test',
        expiresInSeconds: 300,
      });
      const client = axios.create({
        baseURL: baseUrl,
        timeout: 10_000,
        maxRedirects: 0,
        proxy: false,
      });
      const { data: inbox } = await client.get<{
        messages: { ID: string; To: { Address: string }[] }[];
      }>('/api/v1/messages');
      expect(inbox.messages).toHaveLength(2);
      const addresses = inbox.messages.flatMap((message) =>
        message.To.map((recipient) => recipient.Address),
      );
      expect(addresses).toContain('alice@example.com');
      expect(addresses).toContain('sms+2348012345678@sms.axiapay.test');
      const { data: details } = await client.get<{ Text: string }>(
        `/api/v1/message/${inbox.messages[0]?.ID}`,
      );
      expect(details.Text).toContain('543210');
    } finally {
      await container.stop();
    }
  });
  it('rejects non-loopback delivery endpoints', () => {
    expect(
      () => new MailpitAuthenticationCodeDelivery('https://example.com'),
    ).toThrow('loopback');
  });
});
