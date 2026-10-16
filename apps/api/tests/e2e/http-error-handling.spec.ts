/** Exercise the real global/scoped Nest boundaries, including failures before route execution and safe financial recovery contracts. */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { HttpException, Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApplication } from '../../src/bootstrap/create-application.js';
import { HealthService } from '../../src/modules/health/services/health.service.js';
import { AuthenticationService } from '../../src/modules/authentication/services/authentication.service.js';
import { AuthenticationError } from '../../src/modules/authentication/domain/authentication-error.js';
import { WalletError } from '@axiapay/payments-runtime/modules/wallets/domain/wallet-error';
import { PaymentError } from '@axiapay/payments-runtime/modules/payments/domain/payment';
import { WalletPaymentService } from '@axiapay/payments-runtime/modules/payments/services/wallet-payment.service';
import { FundingError } from '../../src/modules/wallet-funding/domain/funding.js';
import { ConversionError } from '../../src/modules/airtime-conversion/domain/conversion.js';
import type { HttpErrorResponse } from '../../src/shared/http/http-failure.js';

const privateText = 'private-password signed-provider-payload SQL parameters';
const identity = 'c764f366-e737-4c84-b63b-0df02ad39c76';
const authorization = `Bearer ${'A'.repeat(43)}`;
const login = {
  contact: { kind: 'email', value: 'alice@example.com' },
  password: 'private-password-long-enough',
};
let application: NestFastifyApplication;

beforeAll(async () => {
  application = await createApplication();
  application.use('/middleware-error', () => {
    throw new Error(privateText);
  });
  await application.init();
  await application.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await application?.close();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('global HTTP failure boundary', () => {
  it.each([
    new Error(privateText, { cause: new Error(privateText) }),
    new TypeError(privateText),
    privateText,
    null,
    undefined,
    { statusCode: 401, code: 'INVALID_CREDENTIALS', message: privateText },
  ])('redacts unexpected and non-Error failures (%j)', async (error) => {
    vi.spyOn(application.get(HealthService), 'live').mockImplementationOnce(
      () => {
        throw error;
      },
    );
    const log = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const response = await application.inject({
      method: 'GET',
      url: `/health/live?token=${privateText}`,
      headers: { 'x-request-id': 'untrusted-caller-reference' },
    });
    expect(response.statusCode).toBe(500);
    const requestId = response.headers['x-request-id'];
    expect(requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(response.json()).toEqual({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
      requestId,
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(log).toHaveBeenCalledWith({
      event: 'http_request_failed',
      requestId,
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(privateText);
  });

  it.each([
    [400, 'INVALID_INPUT'],
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [413, 'PAYLOAD_TOO_LARGE'],
    [415, 'UNSUPPORTED_MEDIA_TYPE'],
    [422, 'UNPROCESSABLE_ENTITY'],
    [429, 'RATE_LIMITED'],
    [500, 'INTERNAL_ERROR'],
    [502, 'BAD_GATEWAY'],
    [503, 'SERVICE_UNAVAILABLE'],
    [504, 'GATEWAY_TIMEOUT'],
    [412, 'HTTP_ERROR'],
  ])(
    'preserves HTTP %i without exposing exception response fields',
    async (statusCode, code) => {
      vi.spyOn(application.get(HealthService), 'live').mockImplementationOnce(
        () => {
          throw new HttpException(
            {
              message: privateText,
              details: { password: privateText },
              code: privateText,
            },
            statusCode,
          );
        },
      );
      const response = await application.inject({
        method: 'GET',
        url: '/health/live',
      });
      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toMatchObject({
        statusCode,
        code,
        requestId: response.headers['x-request-id'],
      });
      expect(response.body).not.toContain(privateText);
      expect(Object.keys(response.json())).toEqual([
        'statusCode',
        'code',
        'message',
        'requestId',
      ]);
    },
  );

  it.each([200, 399, 600, Number.NaN, Number.POSITIVE_INFINITY])(
    'turns an invalid exception status %s into a safe server error',
    async (status) => {
      vi.spyOn(application.get(HealthService), 'live').mockImplementationOnce(
        () => {
          throw new HttpException(privateText, status);
        },
      );
      const response = await application.inject({
        method: 'GET',
        url: '/health/live',
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({
        statusCode: 500,
        code: 'INTERNAL_ERROR',
      });
      expect(response.body).not.toContain(privateText);
    },
  );

  it('returns the common envelope for missing routes and middleware failures', async () => {
    for (const [url, statusCode, code] of [
      ['/v1/no-such-route', 404, 'NOT_FOUND'],
      ['/middleware-error', 500, 'INTERNAL_ERROR'],
    ] as const) {
      const response = await application.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toMatchObject({
        statusCode,
        code,
        requestId: response.headers['x-request-id'],
      });
      expect(response.body).not.toContain(privateText);
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });

  it.each([
    [
      'application/json',
      '{"password":"private-password",',
      400,
      'INVALID_INPUT',
    ],
    ['application/json', '', 400, 'INVALID_INPUT'],
    [
      'application/xml',
      '<password>private-password</password>',
      415,
      'UNSUPPORTED_MEDIA_TYPE',
    ],
    [
      'application/json',
      JSON.stringify({ password: 'x'.repeat(1_048_577) }),
      413,
      'PAYLOAD_TOO_LARGE',
    ],
  ])(
    'handles %s parser failures before workflow side effects',
    async (contentType, payload, statusCode, code) => {
      const operation = vi.spyOn(
        application.get(AuthenticationService),
        'loginWithPassword',
      );
      const response = await application.inject({
        method: 'POST',
        url: '/v1/auth/login/password',
        headers: { 'content-type': contentType },
        payload,
      });
      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toMatchObject({
        statusCode,
        code,
        requestId: response.headers['x-request-id'],
      });
      expect(response.body).not.toContain('private-password');
      expect(operation).not.toHaveBeenCalled();
    },
  );

  it('assigns different server request references to concurrent failures', async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        application.inject({
          method: 'GET',
          url: '/v1/no-such-route',
          headers: { 'x-request-id': 'same-caller-value' },
        }),
      ),
    );
    expect(
      new Set(
        responses.map(
          (response) => response.json<HttpErrorResponse>().requestId,
        ),
      ).size,
    ).toBe(8);
  });
});

describe('shared feature error handling', () => {
  it('retains rate-limit retry guidance and uses the same correlated envelope', async () => {
    vi.spyOn(
      application.get(AuthenticationService),
      'loginWithPassword',
    ).mockRejectedValueOnce(
      new AuthenticationError('RATE_LIMITED', 'Try again later.', 45),
    );
    const response = await application.inject({
      method: 'POST',
      url: '/v1/auth/login/password',
      payload: login,
    });
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('45');
    expect(response.json()).toEqual({
      statusCode: 429,
      code: 'RATE_LIMITED',
      message: 'Try again later.',
      retryAfterSeconds: 45,
      requestId: response.headers['x-request-id'],
    });
  });

  it.each([
    ['/v1/wallets', new WalletError('FORBIDDEN'), 404, 'WALLET_NOT_FOUND'],
    [
      '/v1/wallets',
      new WalletError('INSUFFICIENT_FUNDS'),
      409,
      'INSUFFICIENT_FUNDS',
    ],
    ['/v1/payments', new PaymentError('QUOTE_EXPIRED'), 409, 'QUOTE_EXPIRED'],
    [
      `/v1/wallet-funding/${identity}`,
      new FundingError('FUNDING_CONFLICT'),
      409,
      'FUNDING_CONFLICT',
    ],
    [
      `/v1/airtime-conversions/${identity}`,
      new ConversionError('AIRTIME_INELIGIBLE'),
      422,
      'AIRTIME_INELIGIBLE',
    ],
  ])(
    'preserves scoped business failure %s (%j)',
    async (url, error, statusCode, code) => {
      vi.spyOn(
        application.get(AuthenticationService),
        'authenticate',
      ).mockRejectedValueOnce(error);
      const response = await application.inject({
        method:
          url === '/v1/wallets' || url === '/v1/payments' ? 'POST' : 'GET',
        url,
        headers: { authorization },
      });
      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toMatchObject({
        statusCode,
        code,
        requestId: response.headers['x-request-id'],
      });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers.pragma).toBe('no-cache');
    },
  );

  it.each([
    ['/v1/wallets', 'WALLET_UNAVAILABLE'],
    ['/v1/payments', 'PAYMENT_UNAVAILABLE'],
    [`/v1/wallet-funding/${identity}`, 'FUNDING_UNAVAILABLE'],
    [`/v1/airtime-conversions/${identity}`, 'CONVERSION_UNAVAILABLE'],
  ])(
    'retains safe uncertainty for unclassified failures on %s',
    async (url, code) => {
      vi.spyOn(
        application.get(AuthenticationService),
        'authenticate',
      ).mockRejectedValueOnce(new Error(privateText));
      const response = await application.inject({
        method:
          url === '/v1/wallets' || url === '/v1/payments' ? 'POST' : 'GET',
        url,
        headers: { authorization },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        statusCode: 503,
        code,
        requestId: response.headers['x-request-id'],
      });
      expect(response.body).not.toContain(privateText);
    },
  );

  it('preserves payment recovery guidance after an asynchronous submission failure', async () => {
    vi.spyOn(
      application.get(AuthenticationService),
      'authenticate',
    ).mockResolvedValue({
      id: identity,
      contact: { kind: 'email', value: login.contact.value },
      verifiedAt: new Date().toISOString(),
    });
    const submit = vi
      .spyOn(application.get(WalletPaymentService), 'submit')
      .mockRejectedValueOnce(new Error(privateText));
    const response = await application.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { authorization },
      payload: { quoteId: identity, requestKey: identity },
    });
    expect(submit).toHaveBeenCalledOnce();
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: 'PAYMENT_UNAVAILABLE',
      message: expect.stringContaining('Keep the same request key'),
    });
  });

  it('handles HTTP exceptions in scoped controllers with their original status', async () => {
    vi.spyOn(
      application.get(AuthenticationService),
      'loginWithPassword',
    ).mockRejectedValueOnce(new HttpException(privateText, 403));
    const response = await application.inject({
      method: 'POST',
      url: '/v1/auth/login/password',
      payload: login,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
      message: 'Access denied.',
    });
  });

  it('keeps customer bearer challenges separate from partner webhook authentication', async () => {
    const customer = await application.inject({
      method: 'POST',
      url: '/v1/payments',
      payload: {},
    });
    expect(customer.statusCode).toBe(401);
    expect(customer.headers['www-authenticate']).toBe('Bearer');
    const partner = await application.inject({
      method: 'POST',
      url: '/v1/webhooks/wallet-funding/paystack',
      payload: {},
    });
    expect(partner.statusCode).toBe(401);
    expect(partner.json().code).toBe('INVALID_WEBHOOK');
    expect(partner.headers['www-authenticate']).toBeUndefined();
  });

  it('documents one common error schema for framework and feature responses', async () => {
    const response = await application.inject({
      method: 'GET',
      url: '/docs-json',
    });
    const document = response.json();
    const schema = { $ref: '#/components/schemas/HttpErrorResponseDto' };
    expect(
      document.paths['/health/live'].get.responses['500'].content[
        'application/json'
      ].schema,
    ).toEqual(schema);
    expect(
      document.paths['/v1/payments'].post.responses['409'].content[
        'application/json'
      ].schema,
    ).toEqual(schema);
    expect(document.components.schemas.HttpErrorResponseDto.required).toEqual([
      'statusCode',
      'code',
      'message',
      'requestId',
    ]);
  });
});
