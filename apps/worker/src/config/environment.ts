/** Validate only the resources owned by the standalone background process. */
import { z } from 'zod';
import { paymentProviderEnvironmentSchema } from '@axiapay/payments-runtime/infrastructure/config/payment-provider-environment';

const workerEnvironmentSchema = paymentProviderEnvironmentSchema.safeExtend({
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_QUEUE_URL: z.url({ protocol: /^rediss?$/ }),
  PAYMENT_RECOVERY_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  PAYMENT_RECOVERY_CONCURRENCY: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(4),
});

/** Validated worker settings; the API's authentication, listener and funding settings are deliberately absent. */
export type WorkerEnvironment = z.infer<typeof workerEnvironmentSchema>;

/** Reject invalid deployment configuration with field names only, never supplied values. */
export function validateWorkerEnvironment(
  input: Record<string, unknown>,
): WorkerEnvironment {
  const result = workerEnvironmentSchema.safeParse(input);
  if (result.success) {
    return result.data;
  }
  const fields = [
    ...new Set(result.error.issues.map((issue) => issue.path.join('.'))),
  ];
  throw new Error(`Invalid worker configuration fields: ${fields.join(', ')}`);
}
