/** Verify API replicas never consume recovery jobs, even when old deployment flags are still present. */
import { ModulesContainer } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { createApplication } from '../../src/bootstrap/create-application.js';

describe('API process isolation', () => {
  it('boots without a recovery consumer or reachable queue Redis', async () => {
    vi.stubEnv('PAYMENT_RECOVERY_ENABLED', 'true');
    vi.stubEnv('REDIS_QUEUE_URL', 'redis://127.0.0.1:1');
    const application = await createApplication();
    try {
      await application.init();
      const providers = [...application.get(ModulesContainer).values()].flatMap(
        (module) =>
          [...module.providers.values()].map(
            (provider) => provider.metatype?.name,
          ),
      );
      expect(providers).not.toContain('PaymentRecoveryWorker');
      const response = await application.inject({
        method: 'GET',
        url: '/health/live',
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await application.close();
      vi.unstubAllEnvs();
    }
  });
});
