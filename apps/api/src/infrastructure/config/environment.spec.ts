/** Verify configuration rejects invalid inputs without disclosing supplied credentials. */
import { describe, expect, it } from 'vitest';
import { validateEnvironment } from './environment.js';

const settings = {
  AUTH_CODE_SECRET: '11'.repeat(32),
  DATABASE_URL: 'postgresql://user:secret@localhost/app',
  REDIS_CACHE_URL: 'redis://localhost:56379',
  REDIS_QUEUE_URL: 'redis://localhost:56380',
};
describe('API configuration', () => {
  it('requires complete VTpass credentials, separate fee routing and an explicit live environment in production', () => {
    const vtpass = {
      ...settings,
      VTPASS_API_KEY: 'test-static-key',
      VTPASS_SECRET_KEY: 'test-secret-key',
      VTPASS_PARTNER_ACCOUNT_ID: '8f819840-74b1-4822-a55b-f4fbaf1f2c90',
    };
    expect(validateEnvironment(vtpass).VTPASS_ENVIRONMENT).toBe('sandbox');
    expect(() =>
      validateEnvironment({ ...settings, VTPASS_API_KEY: 'private-value' }),
    ).toThrow('VTPASS_SECRET_KEY');
    expect(() =>
      validateEnvironment({
        ...vtpass,
        VTPASS_FEE_ACCOUNT_ID: vtpass.VTPASS_PARTNER_ACCOUNT_ID,
      }),
    ).toThrow('VTPASS_FEE_ACCOUNT_ID');
    expect(() =>
      validateEnvironment({ ...vtpass, NODE_ENV: 'production' }),
    ).toThrow('VTPASS_ENVIRONMENT');
    expect(() =>
      validateEnvironment({ ...vtpass, VTPASS_SECRET_KEY: 'private-value\n' }),
    ).toThrow(/^Invalid API configuration fields: VTPASS_SECRET_KEY$/);
  });
  it('requires complete partner configuration and separates test/live and partner ledger identities', () => {
    const paystack = {
      ...settings,
      PAYSTACK_SECRET_KEY: 'sk_test_example',
      PAYSTACK_LEDGER_ACCOUNT_ID: '8f819840-74b1-4822-a55b-f4fbaf1f2c90',
      FUNDING_RETURN_URL: 'https://axiapay.example/return',
    };
    expect(validateEnvironment(paystack).FUNDING_ENVIRONMENT).toBe('test');
    expect(() =>
      validateEnvironment({
        ...settings,
        PAYSTACK_SECRET_KEY: 'sk_test_example',
      }),
    ).toThrow('PAYSTACK_LEDGER_ACCOUNT_ID');
    expect(() =>
      validateEnvironment({ ...paystack, FUNDING_ENVIRONMENT: 'live' }),
    ).toThrow('PAYSTACK_SECRET_KEY');
    expect(() =>
      validateEnvironment({ ...settings, OPAY_MERCHANT_ID: '123456' }),
    ).toThrow('OPAY_SECRET_KEY');
    expect(() =>
      validateEnvironment({
        ...paystack,
        OPAY_LEDGER_ACCOUNT_ID: paystack.PAYSTACK_LEDGER_ACCOUNT_ID,
      }),
    ).toThrow('OPAY_LEDGER_ACCOUNT_ID');
  });
  it('requires a deployment-specific code secret and blocks local delivery in production', () => {
    expect(() =>
      validateEnvironment({ ...settings, AUTH_CODE_SECRET: '' }),
    ).toThrow('AUTH_CODE_SECRET');
    expect(() =>
      validateEnvironment({ ...settings, NODE_ENV: 'production' }),
    ).toThrow('AUTH_CODE_DELIVERY');
  });
  it('coerces valid ports and supplies local listener defaults', () => {
    expect(validateEnvironment({ ...settings, PORT: '4100' })).toMatchObject({
      PORT: 4100,
      HOST: '127.0.0.1',
      NODE_ENV: 'development',
    });
  });
  it.each(['0', '65536', 'not-a-port'])('rejects invalid port %s', (port) => {
    expect(() => validateEnvironment({ ...settings, PORT: port })).toThrow(
      'PORT',
    );
  });
  it('requires both data-source URLs and rejects wrong protocols', () => {
    expect(() => validateEnvironment({})).toThrow('DATABASE_URL');
    expect(() =>
      validateEnvironment({ ...settings, DATABASE_URL: 'https://localhost' }),
    ).toThrow('DATABASE_URL');
    expect(() =>
      validateEnvironment({
        ...settings,
        REDIS_CACHE_URL: 'https://localhost',
      }),
    ).toThrow('REDIS_CACHE_URL');
  });
  it('reports invalid fields without exposing the supplied value', () => {
    expect(() =>
      validateEnvironment({
        ...settings,
        DATABASE_URL: 'private-password-value',
      }),
    ).toThrow(/^Invalid API configuration fields: DATABASE_URL$/);
  });
});
