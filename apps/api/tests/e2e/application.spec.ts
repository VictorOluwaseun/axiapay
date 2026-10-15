/** Verify the composed Fastify application exposes liveness and its development API contract. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApplication } from '../../src/bootstrap/create-application.js';
import { WalletService } from '../../src/modules/wallets/services/wallet.service.js';
import { WalletModule } from '../../src/modules/wallets/wallet.module.js';

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
  it('documents all wallet routes with bearer authentication and exact monetary strings', async () => {
    const response = await application.inject({
      method: 'GET',
      url: '/docs-json',
    });
    const document = response.json();
    for (const [route, method] of [
      ['/v1/wallets', 'post'],
      ['/v1/wallets/{walletId}/balance', 'get'],
      ['/v1/wallets/{walletId}/transfers', 'post'],
    ]) {
      expect(document.paths[route!][method!].security).toEqual([
        { bearer: [] },
      ]);
      expect(document.paths[route!][method!].responses).toHaveProperty('401');
    }
    const transfer = document.components.schemas.TransferWalletFundsDto;
    expect(transfer.properties.amountMinorUnits.type).toBe('string');
    expect(transfer.required).toContain('requestKey');
    expect(transfer.required).toContain('currency');
    expect(transfer.properties).not.toHaveProperty('actorId');
    expect(
      document.components.schemas.WalletBalanceResponseDto.properties
        .availableMinorUnits.type,
    ).toBe('string');
  });
  it('documents session-protected funding routes separately from partner-authenticated webhooks', async () => {
    const response = await application.inject({
      method: 'GET',
      url: '/docs-json',
    });
    const document = response.json();
    expect(
      document.paths['/v1/wallets/{walletId}/funding-requests'].post.security,
    ).toEqual([{ bearer: [] }]);
    expect(
      document.paths['/v1/wallets/{walletId}/funding-options'].get.security,
    ).toEqual([{ bearer: [] }]);
    const fundingContract = document.components.schemas.CreateFundingRequestDto;
    expect(fundingContract.required).toContain('fundingOptionId');
    expect(fundingContract.properties.fundingOptionId).not.toHaveProperty(
      'enum',
    );
    expect(fundingContract.properties).not.toHaveProperty('partner');
    expect(
      document.components.schemas.FundingResponseDto.properties,
    ).not.toHaveProperty('adapterId');
    expect(
      document.components.schemas.FundingOptionResponseDto.properties
        .maximumAmountMinorUnits.type,
    ).toBe('string');
    expect(
      document.paths['/v1/wallet-funding/{fundingId}'].get.security,
    ).toEqual([{ bearer: [] }]);
    expect(
      document.paths['/v1/wallet-funding/{fundingId}/reconcile'].post.security,
    ).toEqual([{ bearer: [] }]);
    expect(
      document.paths['/v1/webhooks/wallet-funding/paystack'].post.security,
    ).toBeUndefined();
    expect(
      document.paths['/v1/webhooks/wallet-funding/opay'].post.security,
    ).toBeUndefined();
    expect(
      document.components.schemas.CreateFundingRequestDto.properties
        .amountMinorUnits.type,
    ).toBe('string');
  });
  it('fails closed on unsigned webhooks through the actual raw-body bootstrap', async () => {
    const response = await application.inject({
      method: 'POST',
      url: '/v1/webhooks/wallet-funding/paystack',
      payload: { event: 'charge.success' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('INVALID_WEBHOOK');
  });
  it.each([
    ['POST', '/v1/wallets'],
    ['GET', '/v1/wallets/c764f366-e737-4c84-b63b-0df02ad39c76/balance'],
    ['POST', '/v1/wallets/c764f366-e737-4c84-b63b-0df02ad39c76/transfers'],
  ] as const)(
    'requires a session for %s %s before accessing wallet storage',
    async (method, url) => {
      const response = await application.inject({ method, url });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('INVALID_CREDENTIALS');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['www-authenticate']).toBe('Bearer');
    },
  );
  it('disables trusted integration operations when no verifiers are configured', async () => {
    const wallets = application
      .select(WalletModule)
      .get(WalletService, { strict: true });
    await expect(
      wallets.confirmWalletFunding('untrusted-reference'),
    ).rejects.toMatchObject({ code: 'VERIFICATION_UNAVAILABLE' });
    await expect(
      wallets.settleWalletReservation({
        reservationId: 'untrusted-reservation',
        evidenceReference: 'untrusted-reference',
      }),
    ).rejects.toMatchObject({ code: 'VERIFICATION_UNAVAILABLE' });
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
        statusCode: 400,
        code: 'INVALID_INPUT',
        message: 'Invalid request.',
        requestId: response.headers['x-request-id'],
      });
    },
  );
  it('requires a session before accessing the implemented payment endpoint', async () => {
    const response = await application.inject({
      method: 'POST',
      url: '/v1/payments',
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('INVALID_CREDENTIALS');
  });
});
