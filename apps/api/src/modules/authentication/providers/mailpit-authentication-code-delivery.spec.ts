/** Verify local OTP delivery retains real Axios transformations and hides signed/request details when transport fails. */
import { inspect } from 'node:util';
import { AxiosError, AxiosHeaders, type AxiosAdapter } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { axiosTextResponse } from '../../../../../../packages/backend/tests/support/axios-response-fixture.js';
import { MailpitAuthenticationCodeDelivery } from './mailpit-authentication-code-delivery.js';

/** Deliberately fake code that must never enter a delivery failure or its retained causes. */
const message = {
  contact: { kind: 'email' as const, value: 'alice@example.com' },
  purpose: 'signup' as const,
  code: '012345',
  challengeId: 'local-challenge',
  expiresInSeconds: 300,
};

describe('Mailpit Axios delivery', () => {
  it('uses loopback, a bounded deadline and no redirects for the original code payload', async () => {
    const adapter = vi
      .fn<AxiosAdapter>()
      .mockResolvedValue(axiosTextResponse('{}'));
    await new MailpitAuthenticationCodeDelivery(
      'http://127.0.0.1:8025',
      adapter,
    ).send(message);
    expect(adapter).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        url: 'http://127.0.0.1:8025/api/v1/send',
        method: 'post',
        timeout: 10_000,
        maxRedirects: 0,
        signal: expect.any(AbortSignal),
        data: expect.stringContaining('012345'),
      }),
    );
  });

  it('rejects HTTP errors and strips Axios config containing the OTP from transport failures', async () => {
    const adapter = vi
      .fn<AxiosAdapter>()
      .mockResolvedValueOnce(axiosTextResponse('{}', 503));
    const delivery = new MailpitAuthenticationCodeDelivery(
      'http://127.0.0.1:8025',
      adapter,
    );
    await expect(delivery.send(message)).rejects.toThrow('HTTP 503');
    adapter.mockRejectedValueOnce(
      new AxiosError('private provider details', AxiosError.ETIMEDOUT, {
        headers: new AxiosHeaders(),
        data: JSON.stringify(message),
      }),
    );
    const failure = await delivery
      .send(message)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      message: 'Local code delivery failed or timed out.',
    });
    expect(inspect(failure, { depth: 5 })).not.toMatch(
      /012345|private provider details|alice@example/,
    );
  });
});
