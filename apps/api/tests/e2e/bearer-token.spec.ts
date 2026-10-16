/** Exercise token parameter injection through real auth routes without database or provider calls. */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApplication } from '../../src/bootstrap/create-application.js';
import { AuthenticationService } from '../../src/modules/authentication/services/authentication.service.js';
import { DeviceAuthenticationService } from '../../src/modules/authentication/services/device-authentication.service.js';
import { AuthenticationError } from '../../src/modules/authentication/domain/authentication-error.js';
import * as authenticationHttp from '../../src/modules/authentication/types/authentication-http.js';

const token = 'Ab_9-'.repeat(8) + 'XYZ';
const credentialId = 'c764f366-e737-4c84-b63b-0df02ad39c76';
const deviceRoutes = [
  {
    method: 'POST',
    route: 'devices/enrollment/challenge',
    operation: 'requestEnrollment',
    payload: { deviceName: 'Test phone', publicKey: 'AAAA' },
  },
  {
    method: 'POST',
    route: 'devices/enrollment/verify',
    operation: 'verifyEnrollment',
    payload: { credentialId, challengeId: credentialId, signature: 'AAAA' },
  },
  { method: 'GET', route: 'devices', operation: 'list' },
  { method: 'DELETE', route: `devices/${credentialId}`, operation: 'revoke' },
] as const;
let application: NestFastifyApplication;

beforeAll(async () => {
  application = await createApplication();
  await application.init();
  await application.getHttpAdapter().getInstance().ready();
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await application?.close();
});

describe('Bearer token controller parameters', () => {
  it('passes the extracted token to idempotent logout without requiring an active session', async () => {
    const readToken = vi.spyOn(authenticationHttp, 'readBearerToken');
    const authentication = application.get(AuthenticationService);
    const authenticate = vi.spyOn(authentication, 'authenticate');
    const logout = vi
      .spyOn(authentication, 'logout')
      .mockResolvedValue(undefined);
    const response = await application.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: `bEaReR ${token}` },
    });
    expect(response.statusCode).toBe(204);
    expect(logout).toHaveBeenCalledExactlyOnceWith(token);
    expect(authenticate).not.toHaveBeenCalled();
    expect(readToken).toHaveBeenCalledExactlyOnceWith(`bEaReR ${token}`);
  });

  it.each([undefined, `Basic ${token}`, `Bearer ${token} extra`])(
    'rejects malformed logout authorization before revocation (%j)',
    async (authorization) => {
      const logout = vi.spyOn(application.get(AuthenticationService), 'logout');
      const response = await application.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: authorization === undefined ? {} : { authorization },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('INVALID_CREDENTIALS');
      expect(logout).not.toHaveBeenCalled();
    },
  );

  it.each(deviceRoutes)(
    'parses once and passes the guard-checked token to $operation',
    async (route) => {
      const readToken = vi.spyOn(authenticationHttp, 'readBearerToken');
      const authenticate = vi
        .spyOn(application.get(AuthenticationService), 'authenticate')
        .mockResolvedValue({
          id: credentialId,
          contact: { kind: 'email', value: 'test@example.com' },
          verifiedAt: '2030-01-01T00:00:00.000Z',
        });
      const operation = vi
        .spyOn(application.get(DeviceAuthenticationService), route.operation)
        .mockRejectedValue(
          new AuthenticationError(
            'RECENT_AUTHENTICATION_REQUIRED',
            'Sign in again.',
          ),
        );
      const response = await application.inject({
        method: route.method,
        url: `/v1/auth/${route.route}`,
        remoteAddress: '198.51.100.10',
        headers: {
          authorization: `Bearer ${token}`,
          'x-forwarded-for': '203.0.113.20',
        },
        ...('payload' in route ? { payload: route.payload } : {}),
      });
      expect(response.statusCode).toBe(403);
      expect(authenticate).toHaveBeenCalledExactlyOnceWith(
        token,
        route.method !== 'GET',
      );
      expect(readToken).toHaveBeenCalledExactlyOnceWith(`Bearer ${token}`);
      expect(operation).toHaveBeenCalledTimes(1);
      expect(operation.mock.calls[0]?.[0]).toBe(token);
      if ('payload' in route) {
        expect(operation.mock.calls[0]?.[1]).toMatchObject({
          clientIp: '198.51.100.10',
        });
      }
    },
  );

  it.each(deviceRoutes)(
    'keeps $operation protected when the token is absent',
    async (route) => {
      const authenticate = vi.spyOn(
        application.get(AuthenticationService),
        'authenticate',
      );
      const operation = vi.spyOn(
        application.get(DeviceAuthenticationService),
        route.operation,
      );
      const response = await application.inject({
        method: route.method,
        url: `/v1/auth/${route.route}`,
        ...('payload' in route ? { payload: route.payload } : {}),
      });
      expect(response.statusCode).toBe(401);
      expect(authenticate).not.toHaveBeenCalled();
      expect(operation).not.toHaveBeenCalled();
    },
  );
});
