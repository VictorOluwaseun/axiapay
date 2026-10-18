import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RemoteConfigController } from './controllers/remote-config.controller.js';
import { RemoteConfigRepositoryImpl } from './repositories/remote-config.repository.impl.js';
import { RemoteConfigService } from './services/remote-config.service.js';
import { REMOTE_CONFIG_REPOSITORY } from './remote-config.tokens.js';
import { FirebaseRemoteConfigDataSource } from './data-sources/firebase-remote-config.data-source.js';

/** Compose Firebase access, bounded snapshot recovery and public configuration; no PostgreSQL dependency or administration endpoint is exposed. */
@Module({
  imports: [ConfigModule],
  controllers: [RemoteConfigController],
  providers: [
    {
      provide: REMOTE_CONFIG_REPOSITORY,
      inject: [ConfigService],
      useFactory: (configuration: ConfigService) => {
        const projectId = configuration.get<string>('FIREBASE_PROJECT_ID');
        const fetchTimeoutMs = configuration.get<number>(
          'REMOTE_CONFIG_FETCH_TIMEOUT_MS',
          10000,
        );
        const source = projectId
          ? new FirebaseRemoteConfigDataSource(projectId, fetchTimeoutMs)
          : null;
        return new RemoteConfigRepositoryImpl(source, {
          fetchTimeoutMs,
          refreshIntervalMs: configuration.get<number>(
            'REMOTE_CONFIG_REFRESH_INTERVAL_MS',
            60000,
          ),
          maxAgeMs: configuration.get<number>(
            'REMOTE_CONFIG_MAX_AGE_MS',
            300000,
          ),
        });
      },
    },
    RemoteConfigService,
  ],
  exports: [RemoteConfigService],
})
export class RemoteConfigModule {}
