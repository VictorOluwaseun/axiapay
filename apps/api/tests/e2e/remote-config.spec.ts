/** Exercise standard conditional HTTP configuration with real Nest/Fastify handling and an explicit test policy. */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { RemoteConfigModule } from '../../src/modules/remote-config/remote-config.module.js';
import { REMOTE_CONFIG_REPOSITORY } from '../../src/modules/remote-config/remote-config.tokens.js';
import { remoteConfigFlagKeys } from '../../src/modules/remote-config/domain/remote-config.js';
import { TestRemoteConfigRepository } from '../support/remote-config.js';

let application: NestFastifyApplication;
const policy = new TestRemoteConfigRepository();

beforeAll(async () => {
  const module = await Test.createTestingModule({
    imports: [RemoteConfigModule],
  })
    .overrideProvider(REMOTE_CONFIG_REPOSITORY)
    .useValue(policy)
    .compile();
  application = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    { logger: false },
  );
  application.setGlobalPrefix('v1');
  await application.init();
  await application.getHttpAdapter().getInstance().ready();
});
beforeEach(() => {
  vi.restoreAllMocks();
  policy.reset();
});
afterAll(async () => {
  await application?.close();
});

/** Request configuration with an optional previously stored HTTP validator. */
function getConfiguration(etag?: string) {
  return application.inject({
    method: 'GET',
    url: '/v1/config',
    headers: etag === undefined ? {} : { 'if-none-match': etag },
  });
}

describe('versioned public configuration', () => {
  it('returns authentication and payment feature switches and a deterministic opaque version with an ETag suitable for revalidation', async () => {
    const response = await getConfiguration();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      version: expect.stringMatching(/^rc1-[a-f0-9]{64}$/),
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
    expect(response.headers.etag).toBe(`"${response.json().version}"`);
    expect(response.headers['cache-control']).toBe(
      'private, no-cache, must-revalidate',
    );
    const repeat = await getConfiguration();
    expect(repeat.body).toBe(response.body);
    expect(repeat.headers.etag).toBe(response.headers.etag);
  });

  it.each(['CURRENT', 'W/CURRENT', '"old", CURRENT', '"old", W/CURRENT', '*'])(
    'returns an empty 304 for a matching validator (%s)',
    async (validator) => {
      const initial = await getConfiguration();
      const etag = initial.headers.etag as string;
      const response = await getConfiguration(
        validator.replace('CURRENT', etag),
      );
      expect(response.statusCode).toBe(304);
      expect(response.body).toBe('');
      expect(response.headers['content-type']).toBeUndefined();
      expect(response.headers.etag).toBe(etag);
      expect(response.headers['cache-control']).toBe(
        initial.headers['cache-control'],
      );
    },
  );

  it('returns a complete configuration for unknown or unquoted versions', async () => {
    const initial = await getConfiguration();
    for (const validator of [
      '"unknown"',
      initial.json().version,
      'W/invalid',
    ]) {
      const response = await getConfiguration(validator);
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(initial.body);
    }
  });

  it.each(Object.values(remoteConfigFlagKeys))(
    'changes the version when %s changes and handles rollback by content identity',
    async (key) => {
      const initial = await getConfiguration();
      policy.setFlag(key, false);
      const changed = await getConfiguration(initial.headers.etag as string);
      expect(changed.statusCode).toBe(200);
      expect(changed.json().version).not.toBe(initial.json().version);
      expect(
        (await getConfiguration(changed.headers.etag as string)).statusCode,
      ).toBe(304);
      policy.setFlag(key, true);
      const restored = await getConfiguration(changed.headers.etag as string);
      expect(restored.statusCode).toBe(200);
      expect(restored.json().version).toBe(initial.json().version);
    },
  );

  it('returns 503 instead of 304 when the current snapshot is unavailable, without disclosing provider errors', async () => {
    const initial = await getConfiguration();
    vi.spyOn(policy, 'getFlags').mockRejectedValue(
      new Error('private credential details'),
    );
    for (const validator of [initial.headers.etag as string, '*']) {
      const response = await getConfiguration(validator);
      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe('REMOTE_CONFIG_UNAVAILABLE');
      expect(response.headers.etag).toBeUndefined();
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toContain('private credential details');
    }
  });
});
