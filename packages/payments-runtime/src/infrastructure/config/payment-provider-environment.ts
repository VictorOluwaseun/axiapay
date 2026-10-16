/** Shared provider settings and credential/account consistency rules for API and worker composition; no credentials enter diagnostics. */
import { z } from 'zod';

/** Validate VTpass configuration consistently without imposing HTTP or authentication configuration on headless consumers. */
export const paymentProviderEnvironmentSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
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
  });
