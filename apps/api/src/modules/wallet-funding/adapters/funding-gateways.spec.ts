import { inspect } from 'node:util';
/** Verify partner protocols against published signing rules and exact-number JSON, independently of ledger fixtures. */
import { AxiosError, type AxiosAdapter } from 'axios';
import { axiosTextResponse } from '../../../../../../packages/payments-runtime/tests/support/axios-response-fixture.js';
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { OpayFundingGateway } from './opay-funding.gateway.js';
import { PaystackFundingGateway } from './paystack-funding.gateway.js';
import { parsePartnerJson } from './partner-http.js';
import { outboundBodyLimitBytes } from '@axiapay/payments-runtime/infrastructure/http/axios-client';

const secret = 'sk_test_fixturesecret';
const accountId = '8f819840-74b1-4822-a55b-f4fbaf1f2c90';
const reference = 'ec892cc9-03d9-4df3-9001-ff90d8c47e9b';

describe('funding partner authentication', () => {
  it('rejects oversized partner evidence without confirming funding or retaining credentials', async () => {
    const transport = vi
      .fn<AxiosAdapter>()
      .mockResolvedValue(
        axiosTextResponse('x'.repeat(outboundBodyLimitBytes + 1)),
      );
    const gateway = new PaystackFundingGateway(
      'test',
      accountId,
      secret,
      'https://axiapay.example/return',
      transport,
    );
    const failure = await gateway
      .verify(reference)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'INVALID_FUNDING' });
    expect(inspect(failure, { depth: 5 })).not.toContain(secret);
    expect(transport).toHaveBeenCalledTimes(1);
  });

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
      .fn<AxiosAdapter>()
      .mockResolvedValue(
        axiosTextResponse(
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
      expect.objectContaining({
        url: `https://api.paystack.co/transaction/verify/${reference}`,
        maxRedirects: 0,
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({ Authorization: `Bearer ${secret}` }),
      }),
    );
    transport.mockResolvedValueOnce(
      axiosTextResponse(
        JSON.stringify({ status: true, data: { domain: 'live' } }),
      ),
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
    const transport = vi.fn<AxiosAdapter>().mockResolvedValue(
      axiosTextResponse(
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
      expect.objectContaining({
        url: 'https://testapi.opaycheckout.com/api/v1/international/cashier/status',
        data: body,
        headers: expect.objectContaining({
          MerchantId: '256612345678901',
          Authorization: `Bearer ${createHmac('sha512', 'example-secret').update(body).digest('hex')}`,
        }),
      }),
    );
  });

  it('preserves provider outages and malformed responses as unconfirmed outcomes', async () => {
    const transport = vi
      .fn<AxiosAdapter>()
      .mockImplementation(async (config) => {
        throw new AxiosError(
          'private transport details',
          AxiosError.ERR_NETWORK,
          config,
        );
      });
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
    const failure = await gateway
      .verify(reference)
      .catch((error: unknown) => error);
    expect(inspect(failure, { depth: 5 })).not.toMatch(
      /sk_test_fixturesecret|private transport details/,
    );
    transport.mockResolvedValueOnce(axiosTextResponse('not-json'));
    await expect(gateway.verify(reference)).rejects.toMatchObject({
      code: 'INVALID_FUNDING',
    });
  });
});
