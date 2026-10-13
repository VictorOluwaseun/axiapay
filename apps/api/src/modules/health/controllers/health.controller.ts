import { Controller, Get, Header, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthService } from '../services/health.service.js';

/** Expose operational liveness through an application query without accessing data sources. */
@ApiTags('health')
@Controller('health')
export class HealthController {
  /** Receive the liveness query through the module's explicit dependency wiring. */
  constructor(
    @Inject(HealthService)
    private readonly health: HealthService,
  ) {}

  /** Return an uncached liveness response, never a financial or dependency health guarantee. */
  @Get('live')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Check API process liveness' })
  live() {
    return this.health.live();
  }
}
