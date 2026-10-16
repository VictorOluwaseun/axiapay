import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CacheInvalidationConnection } from './cache-invalidation.connection.js';
import type { AuthenticationDatabase } from '../../modules/authentication/repositories/authentication-database.js';

/** Own the authentication outbox's bounded, lifecycle-managed recovery pool. */
@Injectable()
export class SessionCacheInvalidationConnection extends CacheInvalidationConnection<AuthenticationDatabase> {
  /** Use validated credentials independently of busy business transactions. */
  constructor(@Inject(ConfigService) configuration: ConfigService) {
    super(configuration, 'auth-cache-invalidation');
  }
}
