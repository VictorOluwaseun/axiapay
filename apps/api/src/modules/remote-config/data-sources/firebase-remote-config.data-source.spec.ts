/** Verify the documented Firebase REST contract, strict policy decoding and cancellation without using live credentials. */
import { describe, expect, it, vi } from 'vitest';
import type { GoogleAuth } from 'google-auth-library';
import { readFile } from 'node:fs/promises';
import {
  FirebaseRemoteConfigDataSource,
  firebaseConfigParameters,
} from './firebase-remote-config.data-source.js';
import { remoteConfigFlagKeys } from '../domain/remote-config.js';
import { enabledRemoteConfigFlags } from '../../../../tests/support/remote-config.js';

/** Build a provider-shaped server template; unrelated metadata must never become public configuration. */
function serverTemplate() {
  return {
    parameters: Object.fromEntries(
      Object.values(firebaseConfigParameters).map((name) => [
        name,
        {
          valueType: 'BOOLEAN',
          defaultValue: { value: 'true' },
        },
      ]),
    ),
    version: {
      versionNumber: '99',
      updateUser: { email: 'private-administrator@example.com' },
    },
  };
}

/** Replace only the authenticated transport, retaining the production boundary decoder. */
function dataSource(payload: unknown) {
  const request = vi
    .fn<GoogleAuth['request']>()
    .mockResolvedValue({ data: payload } as Awaited<
      ReturnType<GoogleAuth['request']>
    >);
  return {
    source: new FirebaseRemoteConfigDataSource('axiapay-test', 1000, {
      request: request as GoogleAuth['request'],
    }),
    request,
  };
}

describe('Firebase remote configuration boundary', () => {
  it('accepts the supplied starter template as a complete enabled server policy', async () => {
    const template = JSON.parse(
      await readFile(
        new URL(
          '../../../../config/firebase-remote-config.server.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const { source } = dataSource(template);
    await expect(
      source.loadFlags(new AbortController().signal),
    ).resolves.toEqual(enabledRemoteConfigFlags());
  });
  it('fetches the server namespace with cancellation and time limits, and exposes only known booleans', async () => {
    const template = serverTemplate();
    template.parameters.internal_secret = {
      valueType: 'STRING',
      defaultValue: { value: 'private-provider-value' },
    };
    template.parameters[
      firebaseConfigParameters[remoteConfigFlagKeys.signupEmail]
    ]!.defaultValue.value = 'false';
    const { source, request } = dataSource(template);
    const controller = new AbortController();
    const flags = await source.loadFlags(controller.signal);
    expect(flags).toEqual({
      ...enabledRemoteConfigFlags(),
      [remoteConfigFlagKeys.signupEmail]: false,
    });
    expect(Object.isFrozen(flags)).toBe(true);
    expect(request).toHaveBeenCalledWith({
      method: 'GET',
      url: 'https://firebaseremoteconfig.googleapis.com/v1/projects/axiapay-test/remoteConfig',
      params: {
        name: 'projects/axiapay-test/namespaces/firebase-server/remoteConfig',
      },
      responseType: 'json',
      timeout: 1000,
      retry: false,
      maxRedirects: 0,
      signal: controller.signal,
    });
    expect(JSON.stringify(flags)).not.toContain('private-');
  });

  it.each([
    undefined,
    { valueType: 'STRING', defaultValue: { value: 'false' } },
    { valueType: 'BOOLEAN' },
    { valueType: 'BOOLEAN', defaultValue: { useInAppDefault: true } },
    { valueType: 'BOOLEAN', defaultValue: { value: false } },
    { valueType: 'BOOLEAN', defaultValue: { value: 'False' } },
    { valueType: 'BOOLEAN', defaultValue: { value: 'true ' } },
    {
      valueType: 'BOOLEAN',
      defaultValue: { value: 'true', useInAppDefault: true },
    },
    {
      valueType: 'BOOLEAN',
      defaultValue: { value: 'true' },
      conditionalValues: { random_rollout: { value: 'false' } },
    },
  ])(
    'rejects incomplete, coerced or targeted authentication settings (%j)',
    async (parameter) => {
      const template = serverTemplate();
      const parameters: Record<string, unknown> = {
        ...template.parameters,
        auth_login_phone_enabled: parameter,
      };
      const { source } = dataSource({ ...template, parameters });
      await expect(
        source.loadFlags(new AbortController().signal),
      ).rejects.toThrow(
        'Invalid Firebase configuration parameter: auth_login_phone_enabled.',
      );
    },
  );

  it.each([
    'auth_signup_password_enabled',
    'auth_signup_otp_enabled',
    'auth_login_password_enabled',
    'auth_login_otp_enabled',
  ])(
    'rejects missing credential policy %s instead of enabling it implicitly',
    async (name) => {
      const template = serverTemplate();
      delete template.parameters[name];
      const { source } = dataSource(template);
      await expect(
        source.loadFlags(new AbortController().signal),
      ).rejects.toThrow(`Invalid Firebase configuration parameter: ${name}.`);
    },
  );

  it.each(
    Object.values(firebaseConfigParameters).filter((name) =>
      name.startsWith('feature_'),
    ),
  )('requires an explicit valid boolean for %s', async (name) => {
    for (const value of [
      { valueType: 'BOOLEAN', defaultValue: { value: 'yes' } },
      { valueType: 'STRING', defaultValue: { value: 'true' } },
    ]) {
      const template = serverTemplate();
      const { source } = dataSource({
        ...template,
        parameters: { ...template.parameters, [name]: value },
      });
      await expect(
        source.loadFlags(new AbortController().signal),
      ).rejects.toThrow(`Invalid Firebase configuration parameter: ${name}.`);
    }
  });

  it('keeps legacy authentication configuration usable while absent payment switches fail closed', async () => {
    const template = serverTemplate();
    const parameters = Object.fromEntries(
      Object.entries(template.parameters).filter(([name]) =>
        name.startsWith('auth_'),
      ),
    );
    const { source } = dataSource({ ...template, parameters });
    const flags = await source.loadFlags(new AbortController().signal);
    for (const key of Object.values(remoteConfigFlagKeys)) {
      expect(flags[key]).toBe(key.startsWith('authentication.'));
    }
  });

  it.each([undefined, null, {}, { parameters: [] }, { parameters: null }])(
    'rejects an invalid template (%j)',
    async (template) => {
      const { source } = dataSource(template);
      await expect(
        source.loadFlags(new AbortController().signal),
      ).rejects.toThrow('Invalid Firebase Remote Config template shape.');
    },
  );

  it('propagates transport failures to the snapshot owner without converting them into defaults', async () => {
    const { source, request } = dataSource(serverTemplate());
    const failure = new Error('private credential or provider context');
    request.mockRejectedValue(failure);
    await expect(source.loadFlags(new AbortController().signal)).rejects.toBe(
      failure,
    );
  });
});
