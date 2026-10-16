/** Verify independently deployable worker configuration and safe provider validation. */
import { describe, expect, it } from 'vitest';
import { validateWorkerEnvironment } from './environment.js';

const settings = {
  DATABASE_URL: 'postgresql://user:private-password@localhost/app',
  REDIS_QUEUE_URL: 'redis://localhost:56380',
};

describe('worker configuration', () => {
  it('needs only database and queue settings, enables recovery and bounds batches by default', () => {
    const configuration = validateWorkerEnvironment(settings);
    expect(configuration).toMatchObject({
      NODE_ENV: 'development',
      PAYMENT_RECOVERY_ENABLED: true,
      PAYMENT_RECOVERY_CONCURRENCY: 4,
    });
    expect(configuration).not.toHaveProperty('AUTH_CODE_SECRET');
    expect(configuration).not.toHaveProperty('PORT');
    expect(configuration).not.toHaveProperty('REDIS_CACHE_URL');
    expect(
      validateWorkerEnvironment({
        ...settings,
        PAYMENT_RECOVERY_ENABLED: 'false',
      }).PAYMENT_RECOVERY_ENABLED,
    ).toBe(false);
  });
  it.each(['1', '100'])('accepts the concurrency boundary %s', (value) => {
    expect(
      validateWorkerEnvironment({
        ...settings,
        PAYMENT_RECOVERY_CONCURRENCY: value,
      }).PAYMENT_RECOVERY_CONCURRENCY,
    ).toBe(Number(value));
  });
  it.each(['0', '101', '1.5', 'wrong'])(
    'rejects invalid concurrency %s',
    (value) => {
      expect(() =>
        validateWorkerEnvironment({
          ...settings,
          PAYMENT_RECOVERY_CONCURRENCY: value,
        }),
      ).toThrow('PAYMENT_RECOVERY_CONCURRENCY');
    },
  );
  it('rejects invalid queue/database settings and flags without disclosing their values', () => {
    expect(() =>
      validateWorkerEnvironment({
        ...settings,
        DATABASE_URL: 'private-password',
      }),
    ).toThrow(/^Invalid worker configuration fields: DATABASE_URL$/);
    expect(() =>
      validateWorkerEnvironment({
        ...settings,
        REDIS_QUEUE_URL: 'https://localhost',
      }),
    ).toThrow('REDIS_QUEUE_URL');
    expect(() =>
      validateWorkerEnvironment({
        ...settings,
        PAYMENT_RECOVERY_ENABLED: 'yes',
      }),
    ).toThrow('PAYMENT_RECOVERY_ENABLED');
  });
  it('shares provider completeness, account separation and production environment rules with the API', () => {
    const provider = {
      VTPASS_API_KEY: 'test-api-key',
      VTPASS_SECRET_KEY: 'test-secret-key',
      VTPASS_PARTNER_ACCOUNT_ID: '8f819840-74b1-4822-a55b-f4fbaf1f2c90',
    };
    expect(() =>
      validateWorkerEnvironment({ ...settings, VTPASS_API_KEY: 'private-key' }),
    ).toThrow('VTPASS_SECRET_KEY');
    expect(() =>
      validateWorkerEnvironment({
        ...settings,
        ...provider,
        VTPASS_FEE_ACCOUNT_ID: provider.VTPASS_PARTNER_ACCOUNT_ID,
      }),
    ).toThrow('VTPASS_FEE_ACCOUNT_ID');
    expect(() =>
      validateWorkerEnvironment({
        ...settings,
        ...provider,
        NODE_ENV: 'production',
      }),
    ).toThrow('VTPASS_ENVIRONMENT');
    expect(
      validateWorkerEnvironment({
        ...settings,
        ...provider,
        NODE_ENV: 'production',
        VTPASS_ENVIRONMENT: 'live',
      }).NODE_ENV,
    ).toBe('production');
  });
});
