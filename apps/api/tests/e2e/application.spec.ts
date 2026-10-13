/** Verify the composed Fastify application exposes liveness and its development API contract. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApplication } from '../../src/bootstrap/create-application.js';

let application: NestFastifyApplication;
beforeAll(async () => {
  application = await createApplication();
  await application.init();
  await application.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await application?.close();
});
describe('API foundation', () => {
  it('serves uncached liveness without requiring external data sources', async () => {
    const response = await application.inject({
      method: 'GET',
      url: '/health/live',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ status: 'ok', service: 'axiapay-api' });
  });
  it('publishes the documented health route in the OpenAPI contract', async () => {
    const response = await application.inject({
      method: 'GET',
      url: '/docs-json',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().paths).toHaveProperty('/health/live');
  });
  it('does not expose placeholder financial endpoints', async () => {
    const response = await application.inject({
      method: 'POST',
      url: '/v1/payments',
      payload: {},
    });
    expect(response.statusCode).toBe(404);
  });
});
