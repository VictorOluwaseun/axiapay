/** Validate process configuration at the application boundary without logging supplied secrets. */
import { z } from 'zod';

const environmentSchema = z
  .object({
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
    AUTH_CODE_SECRET: z.string().regex(/^[a-fA-F0-9]{64}$/),
    AUTH_CODE_DELIVERY: z.literal('mailpit').default('mailpit'),
    AUTH_MAILPIT_URL: z.url().default('http://127.0.0.1:58025'),
    FUNDING_ENVIRONMENT: z.enum(['test', 'live']).default('test'),
    FUNDING_RETURN_URL: z.url({ protocol: /^https$/ }).optional(),
    PAYSTACK_SECRET_KEY: z
      .string()
      .regex(/^sk_(test|live)_[A-Za-z0-9]+$/)
      .optional(),
    PAYSTACK_LEDGER_ACCOUNT_ID: z.uuid().optional(),
    OPAY_MERCHANT_ID: z
      .string()
      .regex(/^[0-9]+$/)
      .optional(),
    OPAY_PUBLIC_KEY: z.string().min(16).optional(),
    OPAY_SECRET_KEY: z.string().min(16).optional(),
    OPAY_LEDGER_ACCOUNT_ID: z.uuid().optional(),
    OPAY_WEBHOOK_URL: z.url({ protocol: /^https$/ }).optional(),
    VTPASS_ENVIRONMENT: z.enum(['sandbox', 'live']).default('sandbox'),
    VTPASS_API_KEY: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[\x21-\x7e]+(?![\s\S])/)
      .optional(),
    VTPASS_SECRET_KEY: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[\x21-\x7e]+(?![\s\S])/)
      .optional(),
    VTPASS_PARTNER_ACCOUNT_ID: z.uuid().optional(),
    VTPASS_FEE_ACCOUNT_ID: z.uuid().optional(),
  })
  .superRefine((settings, context) => {
    const fields = [
      'VTPASS_API_KEY',
      'VTPASS_SECRET_KEY',
      'VTPASS_PARTNER_ACCOUNT_ID',
    ] as const;
    const requiresVtpass = [...fields, 'VTPASS_FEE_ACCOUNT_ID' as const].some(
      (field) => settings[field] !== undefined,
    );
    if (!requiresVtpass) {
      return;
    }
    for (const field of fields) {
      if (!settings[field]) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'Required for VTpass airtime.',
        });
      }
    }
    if (
      settings.VTPASS_PARTNER_ACCOUNT_ID !== undefined &&
      settings.VTPASS_PARTNER_ACCOUNT_ID === settings.VTPASS_FEE_ACCOUNT_ID
    ) {
      context.addIssue({
        code: 'custom',
        path: ['VTPASS_FEE_ACCOUNT_ID'],
        message: 'Clearing and fee accounts must differ.',
      });
    }
    if (
      settings.NODE_ENV === 'production' &&
      settings.VTPASS_ENVIRONMENT !== 'live'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['VTPASS_ENVIRONMENT'],
        message: 'Sandbox airtime cannot enter production.',
      });
    }
  })
  .superRefine((settings, context) => {
    const paystackFields = [
      'PAYSTACK_SECRET_KEY',
      'PAYSTACK_LEDGER_ACCOUNT_ID',
      'FUNDING_RETURN_URL',
    ] as const;
    const opayFields = [
      'OPAY_SECRET_KEY',
      'OPAY_PUBLIC_KEY',
      'OPAY_MERCHANT_ID',
      'OPAY_LEDGER_ACCOUNT_ID',
      'OPAY_WEBHOOK_URL',
      'FUNDING_RETURN_URL',
    ] as const;
    const requiresPaystack =
      settings.PAYSTACK_SECRET_KEY !== undefined ||
      settings.PAYSTACK_LEDGER_ACCOUNT_ID !== undefined;
    const requiresOpay = opayFields
      .filter((field) => field !== 'FUNDING_RETURN_URL')
      .some((field) => settings[field] !== undefined);
    const required = [
      ...(requiresPaystack ? paystackFields : []),
      ...(requiresOpay ? opayFields : []),
    ];
    for (const field of new Set(required)) {
      if (!settings[field]) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'Required for partner funding.',
        });
      }
    }
    if (
      settings.PAYSTACK_SECRET_KEY &&
      !settings.PAYSTACK_SECRET_KEY.startsWith(
        `sk_${settings.FUNDING_ENVIRONMENT}_`,
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['PAYSTACK_SECRET_KEY'],
        message: 'Partner environment mismatch.',
      });
    }
    if (
      settings.PAYSTACK_LEDGER_ACCOUNT_ID &&
      settings.PAYSTACK_LEDGER_ACCOUNT_ID === settings.OPAY_LEDGER_ACCOUNT_ID
    ) {
      context.addIssue({
        code: 'custom',
        path: ['OPAY_LEDGER_ACCOUNT_ID'],
        message: 'Partners must use distinct ledger accounts.',
      });
    }
    if (
      settings.NODE_ENV === 'production' &&
      settings.FUNDING_ENVIRONMENT !== 'live'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['FUNDING_ENVIRONMENT'],
        message: 'Test funds cannot enter production.',
      });
    }
  })
  .superRefine((settings, context) => {
    if (settings.NODE_ENV !== 'production') {
      return;
    }
    context.addIssue({
      code: 'custom',
      path: ['AUTH_CODE_DELIVERY'],
      message: 'Local code delivery is unavailable in production.',
    });
  });

/** Validated operational settings; credentials must never enter logs or application contracts. */
export type ApiEnvironment = z.infer<typeof environmentSchema>;

/** Reject invalid settings with field names only; preserve defaults for optional settings. */
export function validateEnvironment(
  input: Record<string, unknown>,
): ApiEnvironment {
  const result = environmentSchema.safeParse(input);
  if (result.success) {
    return result.data;
  }
  const fields = [
    ...new Set(result.error.issues.map((issue) => issue.path.join('.'))),
  ];
  throw new Error(`Invalid API configuration fields: ${fields.join(', ')}`);
}
