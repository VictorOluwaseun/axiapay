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
