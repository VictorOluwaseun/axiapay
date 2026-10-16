/** Run configuration and HTTP boot checks with Nest-compatible decorator metadata. */
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@axiapay\/backend\/(.*)$/,
        replacement: fileURLToPath(
          new URL('../../packages/backend/src/$1.ts', import.meta.url),
        ),
      },
    ],
  },
  plugins: [
    swc.vite({
      jsc: {
        target: 'es2023',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
      module: { type: 'es6' },
    }),
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'tests/e2e/**/*.spec.ts'],
    env: {
      NODE_ENV: 'test',
      AUTH_CODE_SECRET: '11'.repeat(32),
      LOG_LEVEL: 'silent',
      DATABASE_URL: 'postgresql://test:test@127.0.0.1:55432/test',
      REDIS_CACHE_URL: 'redis://127.0.0.1:56379',
      REDIS_QUEUE_URL: 'redis://127.0.0.1:56380',
    },
  },
});
