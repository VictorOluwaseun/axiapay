/** Validate process configuration at the application boundary without logging supplied secrets. */
import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_CACHE_URL: z.url({ protocol: /^rediss?$/ }),
  REDIS_QUEUE_URL: z.url({ protocol: /^rediss?$/ }),
});

/** Validated operational settings; credentials must never enter logs or application contracts. */
export type ApiEnvironment = z.infer<typeof environmentSchema>;

/** Reject invalid settings with field names only; preserve defaults for optional settings. */
export function validateEnvironment(
  input: Record<string, unknown>,
): ApiEnvironment {
  const result = environmentSchema.safeParse(input);
  if (result.success) return result.data;
  const fields = [
    ...new Set(result.error.issues.map((issue) => issue.path.join('.'))),
  ];
  throw new Error(`Invalid API configuration fields: ${fields.join(', ')}`);
}
