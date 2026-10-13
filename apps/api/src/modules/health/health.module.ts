import { Module } from '@nestjs/common';
import { GetLivenessUseCase } from './application/use-cases/get-liveness.use-case.js';
import { HealthController } from './delivery/http/health.controller.js';

/** Bind the operational query to its HTTP adapter without introducing domain dependencies. */
@Module({ controllers: [HealthController], providers: [GetLivenessUseCase] })
export class HealthModule {}
