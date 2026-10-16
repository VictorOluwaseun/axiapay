/** Verify the documented VTpass protocol, exact financial encoding, correlated evidence and bounded transport without network purchases. */
import { AxiosError, type AxiosAdapter } from 'axios';
import { axiosTextResponse } from '../../../../tests/support/axios-response-fixture.js';
import { outboundBodyLimitBytes } from '../../../infrastructure/http/axios-client.js';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { VtpassAirtimeAdapter } from './vtpass-airtime.adapter.js';
import { ServicePaymentProcessor } from '../processors/service-payment.processor.js';
import { money } from '../../wallets/domain/money.js';
import {
  parseVtpassJson,
  vtpassMinorUnits,
  vtpassRequestId,
  vtpassMovementId,
} from './vtpass-airtime.protocol.js';
import {
  vtpassDelivered,
  vtpassInstruction,
  vtpassProduct,
} from '../../../../tests/support/vtpass-airtime-fixture.js';

/** Keep fake credentials local to tests and let each scenario control HTTP independently. */
function adapterFixture(environment: 'sandbox' | 'live' = 'sandbox') {
  const payment = vtpassInstruction();
  const transport = vi
    .fn<AxiosAdapter>()
    .mockImplementation(async () =>
      axiosTextResponse(JSON.stringify(vtpassDelivered(payment))),
    );
  const adapter = new VtpassAirtimeAdapter(
    {
      environment,
      providerKey: payment.quote.providerKey,
      apiKey: 'test-static-key',
      secretKey: 'test-secret-key',
    },
    transport,
  );
  return {
    payment,
    transport,
    adapter,
    processor: new ServicePaymentProcessor('airtime', adapter),
  };
}

describe('VTpass airtime protocol', () => {
  it.each([
    [
      'service',
      'SERVICE_NOT_SUPPORTED',
      'The selected provider does not support this payment service.',
    ],
    [
      'route',
      'PROVIDER_ROUTE_MISMATCH',
      'The selected provider account does not match the payment route.',
    ],
    [
      'currency',
      'NGN_CURRENCY_REQUIRED',
      'This provider requires amounts in NGN.',
    ],
    [
      'product',
      'PRODUCT_NOT_SUPPORTED',
      'The selected product is not supported by this provider.',
    ],
    [
      'network',
      'NETWORK_PRODUCT_MISMATCH',
      'The selected mobile network does not match the selected product.',
    ],
    [
      'recipient',
      'RECIPIENT_REQUIRED',
      'A recipient phone number is required for this payment.',
    ],
  ])(
    'explains the specific unsupported %s before processing',
    (field, reason, message) => {
      const { processor, payment } = adapterFixture();
      const invalid = {
        service: { ...payment.quote, serviceType: 'data' as const },
        route: { ...payment.quote, providerKey: 'other-account' },
        currency: { ...payment.quote, principal: money(10_000n, 'USD') },
        product: { ...payment.quote, providerProductCode: 'smile-direct' },
        network: { ...payment.quote, networkCode: 'glo' },
        recipient: { ...payment.quote, recipientPhoneNumber: null },
      };
      const terms = invalid[field as keyof typeof invalid];
      expect(() => processor.validate({ scope: 'quote', terms })).toThrow(
        expect.objectContaining({ reason, message }),
      );
    },
  );

  it('uses the same validator for product and quote currency/network constraints', () => {
    const { adapter, payment } = adapterFixture();
    expect(() =>
      adapter.validate({
        scope: 'product',
        terms: vtpassProduct(payment),
      }),
    ).not.toThrow();
    expect(() =>
      adapter.validate({ scope: 'quote', terms: payment.quote }),
    ).not.toThrow();
    expect(() =>
      adapter.validate({
        scope: 'product',
        terms: { ...vtpassProduct(payment), currency: 'USD' },
      }),
    ).toThrow(expect.objectContaining({ code: 'PAYMENT_UNAVAILABLE' }));
    expect(() =>
      adapter.validate({
        scope: 'quote',
        terms: { ...payment.quote, principal: money(10_000n, 'USD') },
      }),
    ).toThrow(expect.objectContaining({ code: 'PAYMENT_UNAVAILABLE' }));
    expect(() =>
      adapter.validate({
        scope: 'product',
        terms: { ...vtpassProduct(payment), networkCode: 'glo' },
      }),
    ).toThrow(expect.objectContaining({ code: 'PAYMENT_UNAVAILABLE' }));
    expect(() =>
      adapter.validate({
        scope: 'quote',
        terms: { ...payment.quote, networkCode: 'glo' },
      }),
    ).toThrow(expect.objectContaining({ code: 'PAYMENT_UNAVAILABLE' }));
  });

  it('derives the same Lagos-minute reference from persisted claim time across restarts', () => {
    const payment = vtpassInstruction();
    const saved = {
      ...payment,
      submissionStartedAt: new Date('2030-01-01T23:59:59Z'),
    };
    expect(vtpassRequestId(saved)).toBe(
      `203001020059${payment.id.replaceAll('-', '')}`,
    );
    expect(vtpassRequestId({ ...saved })).toBe(vtpassRequestId(saved));
    expect(() =>
      vtpassRequestId({ ...saved, submissionStartedAt: null }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_PAYMENT' }));
  });

  it.each(['mtn', 'airtel', 'glo', 'etisalat'])(
    'uses explicit %s service routing without inferring a network from the recipient',
    (serviceID) => {
      const { adapter, payment } = adapterFixture();
      const quote = {
        ...payment.quote,
        providerProductCode: serviceID,
        networkCode: serviceID,
      };
      expect(adapter.toRequest({ ...payment, quote })).toMatchObject({
        serviceID,
        phone: '08011111111',
        amount: '100.00',
      });
    },
  );

  it('supports T2 and 9mobile as explicit catalogue aliases for etisalat', () => {
    const { adapter, payment } = adapterFixture();
    for (const networkCode of ['t2', '9mobile']) {
      expect(
        adapter.toRequest({
          ...payment,
          quote: {
            ...payment.quote,
            providerProductCode: 'etisalat',
            networkCode,
          },
        }).serviceID,
      ).toBe('etisalat');
    }
  });

  it('preserves raw decimal tokens and movement IDs beyond the safe integer range', () => {
    expect(
      parseVtpassJson(
        '{"id":17415980564672211596777904,"amount":90071992547409.93}',
      ),
    ).toEqual({
      id: '17415980564672211596777904',
      amount: '90071992547409.93',
    });
    expect(vtpassMinorUnits('90071992547409.93')).toBe(9007199254740993n);
  });

  it.each([
    '',
    '.',
    '1.',
    '.1',
    '01',
    '001.00',
    '1.2.3',
    '+100',
    '0x64',
    '１００',
    '100\u0000',
    '1.001',
    '1e2',
    ' 100',
    '100\n',
    '-1',
    '0',
    '92233720368547758.08',
  ])('rejects ambiguous, nonpositive or overflowing amount %j', (amount) => {
    expect(() => vtpassMinorUnits(amount)).toThrow(
      expect.objectContaining({ code: 'INVALID_PROVIDER_EVIDENCE' }),
    );
  });

  it.each([
    ['100', 10000n],
    ['100.0', 10000n],
    ['100.00', 10000n],
    ['0.01', 1n],
  ] as const)(
    'reads exact provider amount %s without floating-point arithmetic',
    (amount, expected) => {
      expect(vtpassMinorUnits(amount)).toBe(expected);
    },
  );

  it.each(['', '0', '01', '-1', '1e24', '123\n', '１', '1'.repeat(65)])(
    'rejects ambiguous provider movement reference %j without numeric coercion',
    (reference) => {
      expect(() => vtpassMovementId(reference)).toThrow(
        expect.objectContaining({
          reason: 'PROVIDER_TRANSACTION_REFERENCE_INVALID',
        }),
      );
    },
  );

  it.each(['sandbox', 'live'] as const)(
    'uses the fixed %s host, POST keys and exact numeric JSON amount',
    async (environment) => {
      const { adapter, payment, transport } = adapterFixture(environment);
      const request = adapter.toRequest({
        ...payment,
        quote: { ...payment.quote, principal: money(9007199254740993n, 'NGN') },
      });
      await adapter.execute(request);
      expect(transport).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          url: `${environment === 'sandbox' ? 'https://sandbox.vtpass.com' : 'https://vtpass.com'}/api/pay`,
          method: 'post',
          maxRedirects: 0,
          timeout: 8000,
          responseType: 'stream',
          maxContentLength: -1,
          transformRequest: [],
          transformResponse: [],
          signal: expect.any(AbortSignal),
          headers: expect.objectContaining({
            'api-key': 'test-static-key',
            'secret-key': 'test-secret-key',
          }),
        }),
      );
      expect(transport.mock.calls[0]![0]!.data).toContain(
        '"amount":90071992547409.93',
      );
      expect(transport.mock.calls[0]![0]!.data).toContain(
        '"phone":"08011111111"',
      );
    },
  );

  it('requires complete delivered evidence and uses unique_element rather than the merchant phone', async () => {
    const { payment, processor } = adapterFixture();
    expect(await processor.submit(payment)).toMatchObject({
      paymentId: payment.id,
      outcome: 'succeeded',
      providerTransactionReference: '17415980564672211596777904',
    });
  });

  it.each([1, '1'])(
    'accepts the redacted production response with quantity %j, keeping gross and commission separate',
    async (quantity) => {
      const { payment, adapter, processor, transport } = adapterFixture('live');
      const response = vtpassDelivered(payment);
      const transaction = (
        response.content as { transactions: Record<string, unknown> }
      ).transactions;
      transaction.quantity = quantity;
      expect(adapter.toSubmission(response, payment)).toMatchObject({
        outcome: 'succeeded',
        providerTransactionReference: '17415980564672211596777904',
      });
      transport.mockResolvedValueOnce(
        axiosTextResponse(JSON.stringify(response)),
      );
      expect((await processor.submit(payment)).outcome).toBe('succeeded');
      expect(payment.quote.principal.amountMinorUnits).toBe(10000n);
      transaction.amount = '97';
      expect(() => adapter.toSubmission(response, payment)).toThrow(
        expect.objectContaining({ reason: 'PROVIDER_AMOUNT_MISMATCH' }),
      );
    },
  );

  it.each(['099', '014', '015', '019', '044', '083', '087', 'new-code'])(
    'keeps %s unresolved without inventing final failure or delivery',
    (code) => {
      const { adapter, payment } = adapterFixture();
      expect(adapter.toSubmission({ code }, payment).outcome).toBe('pending');
    },
  );

  it.each(['initiated', 'pending', 'unknown'])(
    'keeps envelope success with %s transaction state unresolved',
    (status) => {
      const { adapter, payment } = adapterFixture();
      const response = vtpassDelivered(payment);
      (
        response.content as { transactions: Record<string, unknown> }
      ).transactions.status = status;
      expect(adapter.toSubmission(response, payment).outcome).toBe('pending');
    },
  );

  it.each([
    ['unique_element', '08099999999'],
    ['amount', '99'],
    ['unit_price', '99'],
    ['product_name', 'GLO Airtime VTU'],
    ['quantity', '2'],
    ['type', 'Data Services'],
    ['transactionId', undefined],
  ])('rejects mismatched or missing final evidence in %s', (field, value) => {
    const { adapter, payment } = adapterFixture();
    const response = vtpassDelivered(payment);
    (
      response.content as { transactions: Record<string, unknown> }
    ).transactions[field as string] = value;
    expect(() => adapter.toSubmission(response, payment)).toThrow(
      expect.objectContaining({ code: 'INVALID_PROVIDER_EVIDENCE' }),
    );
  });

  it('rejects a missing or changed request reference and a changed envelope amount', () => {
    const { adapter, payment } = adapterFixture();
    for (const overrides of [
      { requestId: undefined },
      { requestId: 'different' },
      { amount: '99' },
    ]) {
      expect(() =>
        adapter.toSubmission(
          { ...vtpassDelivered(payment), ...overrides },
          payment,
        ),
      ).toThrow(expect.objectContaining({ code: 'INVALID_PROVIDER_EVIDENCE' }));
    }
  });

  it('maps authenticated matched outright failures to safe release', () => {
    const { adapter, payment } = adapterFixture();
    for (const code of ['016', '091']) {
      const response = vtpassDelivered(payment);
      response.code = code;
      const transaction = (
        response.content as { transactions: Record<string, unknown> }
      ).transactions;
      transaction.status = 'failed';
      expect(adapter.toSubmission(response, payment)).toMatchObject({
        outcome: 'failed',
        fundsSafeToRelease: true,
      });
    }
  });

  it('accepts documented reversal evidence without success-only fields and keeps net refunds separate', () => {
    const { adapter, payment } = adapterFixture();
    const response = {
      code: '040',
      requestId: vtpassRequestId(payment),
      response_description: 'TRANSACTION REVERSAL TO WALLET',
      amount: '96.50',
      content: {
        transactions: {
          status: 'reversed',
          unique_element: '08011111111',
          unit_price: '100',
          commission: 3.5,
          total_amount: 96.5,
          discount: null,
          amount: '100',
          transactionId: '17415980564672211596777904',
          wallet_credit_id: '17415980564672211596777999',
        },
      },
    };
    expect(adapter.toSubmission(response, payment)).toMatchObject({
      outcome: 'failed',
      fundsSafeToRelease: true,
      evidenceReference:
        'vtpass:sandbox:17415980564672211596777904:refund:17415980564672211596777999',
    });
  });

  it('refuses a reversal without a wallet credit identity', () => {
    const { adapter, payment } = adapterFixture();
    const response = vtpassDelivered(payment);
    response.code = '040';
    (
      response.content as { transactions: Record<string, unknown> }
    ).transactions.status = 'reversed';
    expect(() => adapter.toSubmission(response, payment)).toThrow(
      expect.objectContaining({ code: 'INVALID_PROVIDER_EVIDENCE' }),
    );
  });

  it('enquires through a new adapter instance using the original reference and never calls pay', async () => {
    const { adapter, payment, transport } = adapterFixture();
    expect((await adapter.lookup(payment)).outcome).toBe('succeeded');
    expect(transport).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        url: 'https://sandbox.vtpass.com/api/requery',
        data: JSON.stringify({ request_id: vtpassRequestId(payment) }),
      }),
    );
  });

  it('enquires about accepted terms even when their old network alias no longer passes purchase validation', async () => {
    const { processor, payment, transport } = adapterFixture();
    const accepted = {
      ...payment,
      quote: { ...payment.quote, networkCode: 'retired-mtn-alias' },
    };
    await expect(processor.submit(accepted)).rejects.toMatchObject({
      reason: 'NETWORK_PRODUCT_MISMATCH',
    });
    expect((await processor.lookup(accepted)).outcome).toBe('succeeded');
    expect(transport).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        url: 'https://sandbox.vtpass.com/api/requery',
        data: JSON.stringify({ request_id: vtpassRequestId(accepted) }),
      }),
    );
  });

  it('still rejects mismatched final evidence during lookup of historical terms', async () => {
    const { processor, payment, transport } = adapterFixture();
    const accepted = {
      ...payment,
      quote: { ...payment.quote, networkCode: 'retired-mtn-alias' },
    };
    const response = vtpassDelivered(accepted);
    (
      response.content as { transactions: Record<string, unknown> }
    ).transactions.amount = '99';
    transport.mockResolvedValueOnce(
      axiosTextResponse(JSON.stringify(response)),
    );
    await expect(processor.lookup(accepted)).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_EVIDENCE',
      reason: 'PROVIDER_AMOUNT_MISMATCH',
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]![0].url).toBe(
      'https://sandbox.vtpass.com/api/requery',
    );
  });

  it('rejects unsupported products through the same validation contract used for quotes', () => {
    const { processor, payment } = adapterFixture();
    const product = vtpassProduct(payment);
    expect(() =>
      processor.validate({ scope: 'product', terms: product }),
    ).not.toThrow();
    for (const overrides of [
      { serviceType: 'data' as const },
      { providerProductCode: 'smile-direct' },
      { currency: 'USD' },
      { networkCode: 'glo' },
      { providerKey: 'other-account' },
    ]) {
      expect(() =>
        processor.validate({
          scope: 'product',
          terms: { ...product, ...overrides },
        }),
      ).toThrow();
    }
    expect(() =>
      processor.validate({
        scope: 'quote',
        terms: {
          ...payment.quote,
          recipientPhoneNumber: '+15551234567',
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_PAYMENT' }));
  });

  it('keeps transport failures unconfirmed without retries or credentials in diagnostic causes', async () => {
    const { processor, payment, transport } = adapterFixture();
    transport.mockImplementationOnce(async (config) => {
      throw new AxiosError(
        'test-secret-key private provider response',
        AxiosError.ERR_NETWORK,
        config,
      );
    });
    const error = await processor
      .submit(payment)
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      code: 'PAYMENT_UNAVAILABLE',
      reason: 'PROVIDER_CONNECTION_FAILED',
      message:
        'The payment provider connection failed. The outcome remains unconfirmed; check the existing payment status.',
    });
    expect(inspect(error, { depth: 5 })).not.toMatch(
      /test-secret-key|private provider response/,
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    [302, 'PROVIDER_HTTP_ERROR'],
    [401, 'PROVIDER_AUTHENTICATION_FAILED'],
    [403, 'PROVIDER_AUTHENTICATION_FAILED'],
    [429, 'PROVIDER_RATE_LIMITED'],
    [500, 'PROVIDER_HTTP_ERROR'],
  ] as const)(
    'explains HTTP %s without confirming its payment outcome',
    async (status, reason) => {
      const { processor, payment, transport } = adapterFixture();
      transport.mockResolvedValueOnce(
        axiosTextResponse('private response', status),
      );
      await expect(processor.submit(payment)).rejects.toMatchObject({
        code: 'PAYMENT_UNAVAILABLE',
        reason,
      });
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );

  it('distinguishes a timeout from a provider connection failure without retrying', async () => {
    const { processor, payment, transport } = adapterFixture();
    transport.mockRejectedValueOnce(
      new AxiosError('private timeout details', AxiosError.ETIMEDOUT),
    );
    await expect(processor.submit(payment)).rejects.toMatchObject({
      code: 'PAYMENT_UNAVAILABLE',
      reason: 'PROVIDER_TIMEOUT',
      message:
        'The payment provider request timed out. The outcome remains unconfirmed; check the existing payment status.',
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed JSON and reports the shared response-size failure', async () => {
    const { processor, payment, transport } = adapterFixture();
    transport.mockResolvedValueOnce(axiosTextResponse('private invalid JSON'));
    await expect(processor.submit(payment)).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_EVIDENCE',
      reason: 'PROVIDER_RESPONSE_INVALID_JSON',
      message: 'The payment provider returned invalid JSON.',
    });
    transport.mockResolvedValueOnce(
      axiosTextResponse('x'.repeat(outboundBodyLimitBytes + 1)),
    );
    await expect(processor.submit(payment)).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_EVIDENCE',
      reason: 'PROVIDER_RESPONSE_TOO_LARGE',
      message:
        'The payment provider response exceeded the supported size limit.',
    });
  });
});
