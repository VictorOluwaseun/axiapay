import type { DB } from '../../../infrastructure/database/database.generated.js';

/** Select authentication tables from generated PostgreSQL types; persistence types stay inside the repository implementation. */
export type AuthenticationDatabase = Pick<
  DB,
  'auth_accounts' | 'auth_challenges' | 'auth_sessions' | 'auth_rate_limits'
>;
