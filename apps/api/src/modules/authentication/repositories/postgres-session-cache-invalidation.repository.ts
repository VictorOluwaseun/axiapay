import type { Kysely } from 'kysely';
import { PostgresCacheInvalidationDelivery } from '../../../infrastructure/database/postgres-cache-invalidation-delivery.js';
import type { AuthenticationDatabase } from './authentication-database.js';
import type { SessionIdentityCache } from './contracts/session-identity-cache.js';
import type { SessionCacheInvalidationRepository } from './contracts/session-cache-invalidation.repository.js';

/** Deliver committed auth outbox versions with bounded recovery and Redis generation fencing. */
export class PostgresSessionCacheInvalidationRepository
  extends PostgresCacheInvalidationDelivery<AuthenticationDatabase>
  implements SessionCacheInvalidationRepository
{
  /** Borrow the bounded recovery pool and authentication cache, leaving business transactions independent. */
  constructor(
    database: Kysely<AuthenticationDatabase>,
    cache: SessionIdentityCache,
  ) {
    super(database, cache, 'authentication');
  }
}
