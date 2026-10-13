/** Exercise actual SQL and Redis clients in disposable Docker containers. */
import { defineConfig } from 'vitest/config';
import unitConfiguration from './vitest.config.js';

export default defineConfig({
  ...unitConfiguration,
  test: {
    ...unitConfiguration.test,
    include: ['tests/integration/**/*.spec.ts'],
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
