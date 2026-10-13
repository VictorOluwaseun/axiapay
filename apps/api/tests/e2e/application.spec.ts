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
    expect(response.json().paths).toHaveProperty('/v1/auth/signup');
    expect(
      response.json().paths['/v1/auth/signup'].post.responses['202'].content[
        'application/json'
      ].schema.$ref,
    ).toBe('#/components/schemas/CodeChallengeResponseDto');
    expect(
      response.json().components.schemas.CodeChallengeResponseDto.properties,
    ).toHaveProperty('expiresAt');
    expect(response.json().components.schemas.SignupDto.required).toContain(
      'contact',
    );
    expect(response.json().components.schemas.SignupDto.required).not.toContain(
      'password',
    );
    expect(
      response.json().components.schemas.PasswordLoginDto.required,
    ).toContain('password');
    expect(response.json().components.securitySchemes.bearer.type).toBe('http');
  });
  it.each([
    ['signup', {}],
    ['signup', { contact: null }],
    ['signup', { contact: [{ kind: 'email', value: 'alice@example.com' }] }],
    [
      'signup',
      { contact: { kind: 'email', value: 'alice@example.com', admin: true } },
    ],
    ['signup', { contact: { kind: 'email', value: 12345 } }],
    ['signup', { contact: { kind: 'fax', value: 'alice@example.com' } }],
    [
      'signup',
      {
        contact: { kind: 'email', value: 'alice@example.com' },
        password: null,
      },
    ],
    [
      'signup',
      {
        contact: { kind: 'email', value: 'alice@example.com' },
        password: ['secret-passphrase'],
      },
    ],
    [
      'signup',
      {
        contact: { kind: 'email', value: 'alice@example.com' },
        actorId: 'injected',
      },
    ],
    [
      'login/password',
      { contact: { kind: 'email', value: 'alice@example.com' } },
    ],
    [
      'login/password',
      {
        contact: { kind: 'email', value: 'alice@example.com' },
        password: 123456789,
      },
    ],
    [
      'login/code',
      {
        contact: { kind: 'email', value: 'alice@example.com' },
        password: 'secret-passphrase',
      },
    ],
    [
      'signup/verify',
      { challengeId: 'c764f366-e737-4c84-b63b-0df02ad39c76', code: 123456 },
    ],
    ['login/code/verify', { challengeId: 'not-a-uuid', code: '012345' }],
    [
      'login/code/verify',
      {
        challengeId: 'c764f366-e737-4c84-b63b-0df02ad39c76',
        code: '012345',
        purpose: 'signup',
      },
    ],
  ])(
    'rejects malformed or over-posted %s DTOs before accessing storage (%j)',
    async (route, payload) => {
      const response = await application.inject({
        method: 'POST',
        url: `/v1/auth/${route}`,
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual({
        code: 'INVALID_INPUT',
        message: 'Invalid request body.',
      });
    },
  );
  it('does not expose placeholder financial endpoints', async () => {
    const response = await application.inject({
      method: 'POST',
      url: '/v1/payments',
      payload: {},
    });
    expect(response.statusCode).toBe(404);
  });
});
