import { HealthService } from './services/health.service.js';
import { Module } from '@nestjs/common';
import { HealthController } from './controllers/health.controller.js';

/** Bind the operational service to its HTTP controller without introducing domain dependencies. */
@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
