/** Verify own conversion OpenAPI contracts and authenticated boundaries through the real provider-disabled API bootstrap. */
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

describe('airtime conversion public contracts', () => {
  it('documents exact pricing, consent, instructions and credit recovery independently of providers', async () => {
    const document = (
      await application.inject({ method: 'GET', url: '/docs-json' })
    ).json();
    for (const [route, method] of [
      ['/v1/wallets/{walletId}/airtime-conversion-offers', 'get'],
      ['/v1/airtime-conversions/quotes', 'post'],
      ['/v1/airtime-conversions/quotes/{quoteId}', 'get'],
      ['/v1/airtime-conversions', 'post'],
      ['/v1/airtime-conversions/by-request-key', 'get'],
      ['/v1/airtime-conversions/{conversionId}', 'get'],
      ['/v1/airtime-conversions/{conversionId}/reconcile', 'post'],
    ]) {
      expect(document.paths[route!][method!].security).toEqual([
        { bearer: [] },
      ]);
      expect(document.paths[route!][method!].responses).toHaveProperty('401');
    }
    expect(
      document.components.schemas.CreateConversionQuoteDto.required.sort(),
    ).toEqual([
      'airtimeMinorUnits',
      'offerId',
      'sourcePhoneNumber',
      'walletId',
    ]);
    expect(
      document.components.schemas.AcceptConversionDto.required.sort(),
    ).toEqual(['quoteId', 'requestKey']);
    expect(
      Object.keys(
        document.components.schemas.AcceptConversionDto.properties,
      ).sort(),
    ).toEqual(['quoteId', 'requestKey']);
    for (const field of [
      'airtimeMinorUnits',
      'grossCreditMinorUnits',
      'feeMinorUnits',
      'netCreditMinorUnits',
    ]) {
      expect(
        document.components.schemas.ConversionQuoteResponseDto.properties[field]
          .type,
      ).toBe('string');
    }
    expect(
      document.components.schemas.ConversionOfferResponseDto.properties
        .rateNumerator.type,
    ).toBe('string');
    expect(
      document.components.schemas.ConversionOfferResponseDto.properties
        .grossCreditRounding.enum,
    ).toEqual(['floor']);
    expect(
      document.components.schemas.ConversionOfferResponseDto.properties
        .proportionalFeeRounding.enum,
    ).toEqual(['ceil']);
    for (const name of [
      'ConversionQuoteResponseDto',
      'ConversionOfferResponseDto',
      'ConversionResponseDto',
    ]) {
      for (const field of [
        'providerId',
        'partnerAccountId',
        'externalMovementId',
        'evidenceReference',
        'requestFingerprint',
      ]) {
        expect(document.components.schemas[name].properties).not.toHaveProperty(
          field,
        );
      }
    }
    expect(
      document.paths['/v1/airtime-conversions/{conversionId}/reconcile'].post
        .requestBody.content['application/json'].schema.additionalProperties,
    ).toBe(false);
  });
  it.each([
    [
      'GET',
      '/v1/wallets/ae9b89ce-2d74-486d-9a42-cefe709caf7c/airtime-conversion-offers',
    ],
    ['POST', '/v1/airtime-conversions/quotes'],
    [
      'GET',
      '/v1/airtime-conversions/quotes/ae9b89ce-2d74-486d-9a42-cefe709caf7c',
    ],
    ['POST', '/v1/airtime-conversions'],
    ['GET', '/v1/airtime-conversions/by-request-key?requestKey=owned'],
    ['GET', '/v1/airtime-conversions/ae9b89ce-2d74-486d-9a42-cefe709caf7c'],
    [
      'POST',
      '/v1/airtime-conversions/ae9b89ce-2d74-486d-9a42-cefe709caf7c/reconcile',
    ],
  ] as const)(
    'requires authentication for %s %s before storage or providers',
    async (method, url) => {
      const response = await application.inject({ method, url });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('INVALID_CREDENTIALS');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['www-authenticate']).toBe('Bearer');
    },
  );
});
