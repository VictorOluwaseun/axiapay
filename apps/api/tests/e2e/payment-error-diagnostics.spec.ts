/** Verify descriptive first-party payment errors through the shared HTTP/logging boundary without leaking modified error text or causes. */
import {
  Controller,
  Get,
  Inject,
  Injectable,
  Logger,
  UseFilters,
} from '@nestjs/common';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { HttpErrorHandlingModule } from '../../src/bootstrap/http-error-handling.module.js';
import { PaymentError } from '@axiapay/payments-runtime/modules/payments/domain/payment';
import type { PaymentErrorReason } from '@axiapay/payments-runtime/modules/payments/domain/payment-error-reasons';
import { PaymentExceptionFilter } from '../../src/modules/payments/filters/payment-exception.filter.js';

/** Supply a controlled failure while retaining the real feature/global filter composition. */
@Injectable()
class PaymentFailureSource {
  failure: unknown;
}

/** Expose only a test route for the actual scoped payment filter. */
@Controller('payment-error-check')
@UseFilters(PaymentExceptionFilter)
class PaymentFailureController {
  /** Receive test failure ownership through Nest instead of a global mutable fixture. */
  constructor(
    @Inject(PaymentFailureSource) private readonly source: PaymentFailureSource,
  ) {}

  /** Throw the selected failure without database/provider activity. */
  @Get()
  fail(): never {
    throw this.source.failure;
  }
}

let application: NestFastifyApplication;
let source: PaymentFailureSource;
beforeAll(async () => {
  const module = await Test.createTestingModule({
    imports: [HttpErrorHandlingModule],
    controllers: [PaymentFailureController],
    providers: [PaymentFailureSource, PaymentExceptionFilter],
  }).compile();
  application = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    { logger: false },
  );
  await application.init();
  await application.getHttpAdapter().getInstance().ready();
  source = module.get(PaymentFailureSource);
});
afterAll(async () => application?.close());
afterEach(() => vi.restoreAllMocks());

describe('payment failure explanations', () => {
  it.each([
    ['NGN_CURRENCY_REQUIRED', 'This airtime provider requires amounts in NGN.'],
    [
      'NETWORK_PRODUCT_MISMATCH',
      'The selected mobile network does not match the airtime product.',
    ],
    [
      'PROVIDER_TIMEOUT',
      'The payment provider request timed out. The outcome remains unconfirmed; check the existing payment status.',
    ],
  ] satisfies [PaymentErrorReason, string][])(
    'returns and logs the reason for %s under the same request reference',
    async (reason, message) => {
      source.failure = new PaymentError('PAYMENT_UNAVAILABLE', { reason });
      const log = vi
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const response = await application.inject({
        method: 'GET',
        url: '/payment-error-check',
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        statusCode: 503,
        code: 'PAYMENT_UNAVAILABLE',
        message,
        requestId: response.headers['x-request-id'],
      });
      expect(log).toHaveBeenCalledWith({
        event: 'http_request_failed',
        requestId: response.headers['x-request-id'],
        statusCode: 503,
        code: 'PAYMENT_UNAVAILABLE',
        message,
      });
    },
  );

  it('keeps recipient rejection descriptive without changing its client-error status', async () => {
    source.failure = new PaymentError('INVALID_PAYMENT', {
      reason: 'NIGERIAN_RECIPIENT_REQUIRED',
    });
    const response = await application.inject({
      method: 'GET',
      url: '/payment-error-check',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'INVALID_PAYMENT',
      message:
        'Use a Nigerian recipient phone number in +234 format for this airtime payment.',
    });
  });

  it('preserves a specific reason and cause through an execution-service-style error wrapper', async () => {
    const cause = new PaymentError('INVALID_PROVIDER_EVIDENCE', {
      reason: 'PROVIDER_RECIPIENT_MISMATCH',
    });
    const wrapper = new PaymentError('PAYMENT_UNAVAILABLE', { cause });
    expect(wrapper.reason).toBe('PROVIDER_RECIPIENT_MISMATCH');
    expect(wrapper.message).toBe(
      'The recipient confirmed by the provider does not match this payment.',
    );
    expect(wrapper.cause).toBe(cause);
    source.failure = wrapper;
    const response = await application.inject({
      method: 'GET',
      url: '/payment-error-check',
    });
    expect(response.json()).toMatchObject({
      code: 'PAYMENT_UNAVAILABLE',
      message: wrapper.message,
    });
  });

  it('selects only declared descriptions, never mutable exception text or raw upstream causes', async () => {
    const privateText = 'secret-key provider-payload +2348099999999';
    const failure = new PaymentError('PAYMENT_UNAVAILABLE', {
      reason: 'PROVIDER_CONNECTION_FAILED',
      cause: new Error(privateText),
    });
    failure.message = privateText;
    source.failure = failure;
    const log = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const response = await application.inject({
      method: 'GET',
      url: '/payment-error-check',
    });
    expect(response.json().message).toBe(
      'The payment provider connection failed. The outcome remains unconfirmed; check the existing payment status.',
    );
    expect(response.body).not.toContain(privateText);
    expect(JSON.stringify(log.mock.calls)).not.toContain(privateText);
  });
});
