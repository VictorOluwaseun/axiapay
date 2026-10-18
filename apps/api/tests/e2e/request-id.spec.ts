/** Verify correlation through actual Fastify bootstrap, including failures before route execution and bodyless responses. */
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createApplication } from '../../src/bootstrap/create-application.js';
import { serializeRequest } from '../../src/infrastructure/observability/logger-options.js';
import { HealthService } from '../../src/modules/health/services/health.service.js';
import { RemoteConfigService } from '../../src/modules/remote-config/services/remote-config.service.js';

const deviceId =
  'Samsung-SM-A556E-1792270000000-550e8400-e29b-41d4-a716-446655440000';
let application: NestFastifyApplication;
const rawIdentities = new Map<string, unknown>();

beforeAll(async () => {
  application = await createApplication();
  const fastify = application.getHttpAdapter().getInstance();
  fastify.addHook('onRequest', (request, _reply, done) => {
    rawIdentities.set(request.id, serializeRequest(request.raw).id);
    done();
  });
  await application.init();
  await application.getHttpAdapter().getInstance().ready();
});
afterEach(() => {
  vi.restoreAllMocks();
  rawIdentities.clear();
});
afterAll(async () => {
  await application?.close();
});

describe('request ID HTTP contract', () => {
  it('echoes the Android reference on success and supplies the same raw identity to access logging', async () => {
    const response = await application.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'X-Request-Id': deviceId },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe(deviceId);
    expect(rawIdentities.get(deviceId)).toBe(deviceId);
  });

  it('uses the same caller reference in error headers, body, raw request and structured diagnostics', async () => {
    vi.spyOn(application.get(HealthService), 'live').mockImplementationOnce(
      () => {
        throw new Error('private diagnostic');
      },
    );
    const logger = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const response = await application.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': deviceId },
    });
    expect(response.statusCode).toBe(500);
    expect(response.headers['x-request-id']).toBe(deviceId);
    expect(response.json().requestId).toBe(deviceId);
    expect(rawIdentities.get(deviceId)).toBe(deviceId);
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: deviceId, code: 'INTERNAL_ERROR' }),
    );
    expect(response.body).not.toContain('private diagnostic');
  });

  it.each([
    ['/v1/no-such-route', 'GET', undefined, 404],
    ['/v1/auth/login/password', 'POST', '{', 400],
    ['/v1/wallets/me?currency=NGN', 'GET', undefined, 401],
  ] as const)(
    'retains the reference before workflow handling (%s)',
    async (url, method, payload, status) => {
      const response = await application.inject({
        method,
        url,
        headers: {
          'x-request-id': deviceId,
          'content-type': 'application/json',
        },
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode).toBe(status);
      expect(response.headers['x-request-id']).toBe(deviceId);
      expect(response.json().requestId).toBe(deviceId);
    },
  );

  it.each([
    '',
    'bad reference',
    'Samsung/SM',
    'first,second',
    'a'.repeat(129),
    ['first', 'second'],
  ])(
    'replaces invalid headers and duplicate values without reflecting them (%j)',
    async (supplied) => {
      const response = await application.inject({
        method: 'GET',
        url: '/v1/no-such-route',
        headers: { 'x-request-id': supplied },
      });
      const requestId = response.headers['x-request-id'];
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(response.json().requestId).toBe(requestId);
      expect(rawIdentities.get(requestId as string)).toBe(requestId);
    },
  );

  it('generates fresh fallback references for clients without a header', async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        application.inject({ method: 'GET', url: '/health/live' }),
      ),
    );
    expect(
      new Set(responses.map((response) => response.headers['x-request-id']))
        .size,
    ).toBe(8);
  });

  it('keeps concurrent client references isolated', async () => {
    const ids = Array.from(
      { length: 8 },
      () => `Samsung-SM-123-${randomUUID()}`,
    );
    const responses = await Promise.all(
      ids.map((id) =>
        application.inject({
          method: 'GET',
          url: '/v1/no-such-route',
          headers: { 'x-request-id': id },
        }),
      ),
    );
    expect(responses.map((response) => response.json().requestId)).toEqual(ids);
  });

  it('echoes the reference on 200 and 304 without confusing a request ID with a config ETag', async () => {
    vi.spyOn(
      application.get(RemoteConfigService),
      'getConfiguration',
    ).mockResolvedValue({
      version: 'rc1-test',
      features: {
        airtime: { enabled: true },
        data: { enabled: true },
        electricity: { enabled: true },
        tv: { enabled: true },
        education: { enabled: true },
        insurance: { enabled: true },
        bankTransfer: { enabled: true },
        merchant: { enabled: true },
        airtimeConversion: { enabled: true },
      },
      authentication: {
        signup: {
          emailEnabled: true,
          phoneEnabled: true,
          passwordEnabled: true,
          otpEnabled: true,
        },
        login: {
          emailEnabled: true,
          phoneEnabled: true,
          passwordEnabled: true,
          otpEnabled: true,
        },
      },
    });
    const initial = await application.inject({
      method: 'GET',
      url: '/v1/config',
      headers: { 'x-request-id': deviceId },
    });
    const nextId = `Samsung-SM-123-${randomUUID()}`;
    const repeated = await application.inject({
      method: 'GET',
      url: '/v1/config',
      headers: {
        'x-request-id': nextId,
        'if-none-match': initial.headers.etag as string,
      },
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.headers['x-request-id']).toBe(deviceId);
    expect(repeated.statusCode).toBe(304);
    expect(repeated.headers['x-request-id']).toBe(nextId);
    expect(repeated.headers.etag).toBe(initial.headers.etag);
    expect(repeated.body).toBe('');
  });
});
