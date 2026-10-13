/** Verify partner protocols against published signing rules and exact-number JSON, independently of ledger fixtures. */
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { OpayFundingGateway } from './opay-funding.gateway.js';
import { PaystackFundingGateway } from './paystack-funding.gateway.js';
import { parsePartnerJson } from './partner-http.js';

const secret = 'sk_test_fixturesecret';
const accountId = '8f819840-74b1-4822-a55b-f4fbaf1f2c90';
const reference = 'ec892cc9-03d9-4df3-9001-ff90d8c47e9b';

describe('funding partner authentication', () => {
  it('preserves raw unsigned-64-bit payment IDs and amounts before JSON number rounding', () => {
    expect(
      parsePartnerJson(
        '{"id":18446744073709551615,"amount":9007199254740993,"status":true}',
      ),
    ).toEqual({
      id: '18446744073709551615',
      amount: '9007199254740993',
      status: true,
    });
  });

  it('validates Paystack HMAC over the original bytes and rejects altered or malformed signatures', () => {
    const gateway = new PaystackFundingGateway(
      'test',
      accountId,
      secret,
      'https://axiapay.example/return',
    );
    const raw = Buffer.from(
      `{ "event": "charge.success", "data": {"domain":"test","reference":"${reference}","id":18446744073709551615}}`,
    );
    const signature = createHmac('sha512', secret).update(raw).digest('hex');
    expect(gateway.authenticateNotification(raw, signature)).toEqual({
      reference,
      externalMovementId: '18446744073709551615',
    });
    expect(() =>
      gateway.authenticateNotification(
        Buffer.from(raw.toString().replace(' {', '{')),
        signature,
      ),
    ).toThrow('INVALID_WEBHOOK');
    for (const invalid of [
      undefined,
      '',
      'aa',
      'z'.repeat(128),
      '0'.repeat(128),
    ]) {
      expect(() => gateway.authenticateNotification(raw, invalid)).toThrow(
        'INVALID_WEBHOOK',
      );
    }
  });

  it('checks Paystack transaction-level success and environment through the verify endpoint', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          `{"status":true,"data":{"reference":"${reference}","id":18446744073709551615,"amount":9007199254740993,"currency":"NGN","domain":"test","status":"pending"}}`,
        ),
      );
    const gateway = new PaystackFundingGateway(
      'test',
      accountId,
      secret,
      'https://axiapay.example/return',
      transport,
    );
    expect(await gateway.verify(reference)).toMatchObject({
      isSuccessful: false,
      externalMovementId: '18446744073709551615',
      value: { amountMinorUnits: 9007199254740993n },
    });
    expect(transport).toHaveBeenCalledWith(
      `https://api.paystack.co/transaction/verify/${reference}`,
      expect.objectContaining({
        redirect: 'error',
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({ Authorization: `Bearer ${secret}` }),
      }),
    );
    transport.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: true, data: { domain: 'live' } })),
    );
    await expect(gateway.verify(reference)).rejects.toMatchObject({
      code: 'INVALID_FUNDING',
    });
  });

  it('matches OPay’s published Nigeria callback vector using SHA3-512, not request SHA512', () => {
    // Public test vector from https://documentation.opaycheckout.com/callback-signature (not an application credential).
    const gateway = new OpayFundingGateway(
      'test',
      accountId,
      'example-merchant',
      'example-public',
      'OPAYPRV16498196872570.13953388019021462',
      'https://axiapay.example/return',
      'https://axiapay.example/webhook',
    );
    const event = {
      payload: {
        amount: '49160',
        currency: 'NGN',
        reference: '10023',
        refunded: false,
        status: 'SUCCESS',
        timestamp: '2022-05-07T06:20:46Z',
        token: '220507145660712931829',
        transactionId: '220507145660712931829',
      },
      sha512:
        '9f605d69f04e94172875dc156537071cead060bbcaeaca94a7b8805af9f89611e2fdf6836713c9c90b028ca7e4470b1356e996975f2abc862315aaa9b7f2ae2d',
      type: 'transaction-status',
    };
    expect(
      gateway.authenticateNotification(Buffer.from(JSON.stringify(event))),
    ).toEqual({
      reference: '10023',
      externalMovementId: '220507145660712931829',
    });
    expect(() =>
      gateway.authenticateNotification(
        Buffer.from(
          JSON.stringify({
            ...event,
            payload: { ...event.payload, amount: '49161' },
          }),
        ),
      ),
    ).toThrow('INVALID_WEBHOOK');
  });

  it('uses OPay Nigeria test/live hosts and an ordered SHA512-signed status query', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: '00000',
          data: {
            reference,
            orderNo: '220507145660712931829',
            status: 'SUCCESS',
            isVoided: true,
            amount: { total: 100, currency: 'NGN' },
          },
        }),
      ),
    );
    const gateway = new OpayFundingGateway(
      'test',
      accountId,
      '256612345678901',
      'example-public',
      'example-secret',
      'https://axiapay.example/return',
      'https://axiapay.example/webhook',
      transport,
    );
    expect(await gateway.verify(reference)).toMatchObject({
      isSuccessful: false,
      externalMovementId: '220507145660712931829',
    });
    const body = JSON.stringify({ country: 'NG', reference });
    expect(transport).toHaveBeenCalledWith(
      'https://testapi.opaycheckout.com/api/v1/international/cashier/status',
      expect.objectContaining({
        body,
        headers: expect.objectContaining({
          MerchantId: '256612345678901',
          Authorization: `Bearer ${createHmac('sha512', 'example-secret').update(body).digest('hex')}`,
        }),
      }),
    );
  });

  it('preserves provider outages and malformed responses as unconfirmed outcomes', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('private transport details'));
    const gateway = new PaystackFundingGateway(
      'test',
      accountId,
      secret,
      'https://axiapay.example/return',
      transport,
    );
    await expect(gateway.verify(reference)).rejects.toMatchObject({
      code: 'FUNDING_UNAVAILABLE',
    });
    transport.mockResolvedValueOnce(new Response('not-json'));
    await expect(gateway.verify(reference)).rejects.toMatchObject({
      code: 'INVALID_FUNDING',
    });
  });
});
