import type { DB } from '@axiapay/payments-runtime/infrastructure/database/database.generated';

/** Select authentication tables from generated PostgreSQL types; persistence types stay inside the repository implementation. */
export type AuthenticationDatabase = Pick<
  DB,
  | 'auth_accounts'
  | 'auth_challenges'
  | 'auth_sessions'
  | 'auth_rate_limits'
  | 'auth_device_credentials'
  | 'auth_device_challenges'
>;
