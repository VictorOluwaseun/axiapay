import {
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  Res,
  UseFilters,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import fresh from 'fresh';
import { RemoteConfigService } from '../services/remote-config.service.js';
import { RemoteConfigResponseDto } from '../dtos/remote-config-response.dto.js';
import { RemoteConfigExceptionFilter } from '../filters/remote-config-exception.filter.js';
import type { RemoteConfigHttpResponse } from '../types/remote-config-http.js';

/** Expose versioned non-secret configuration before authentication; Firebase remains the administration boundary. */
@ApiTags('remote-config')
@UseFilters(RemoteConfigExceptionFilter)
@Controller('config')
export class RemoteConfigController {
  /** Receive configuration operations through explicit module composition. */
  constructor(
    @Inject(RemoteConfigService)
    private readonly configuration: RemoteConfigService,
  ) {}

  /** Revalidate only after obtaining usable policy; an unavailable or expired snapshot can never produce a misleading 304. */
  @Get()
  @Header('Cache-Control', 'private, no-cache, must-revalidate')
  @ApiHeader({
    name: 'If-None-Match',
    required: false,
    description:
      'Previously returned quoted ETag; a matching version returns 304 with no body.',
  })
  @ApiOperation({ summary: 'Get public application configuration' })
  @ApiResponse({
    status: 200,
    type: RemoteConfigResponseDto,
    headers: {
      ETag: {
        description: 'Quoted opaque configuration version.',
        schema: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 304,
    description:
      'Configuration unchanged. Empty body; retain the previously stored configuration.',
    headers: {
      ETag: {
        description: 'Current quoted configuration version.',
        schema: { type: 'string' },
      },
    },
  })
  @ApiResponse({ status: 503, description: 'Configuration is unavailable.' })
  async getConfiguration(
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: RemoteConfigHttpResponse,
  ): Promise<RemoteConfigResponseDto | undefined> {
    const configuration = await this.configuration.getConfiguration();
    const etag = `"${configuration.version}"`;
    response.header('ETag', etag);
    if (fresh({ 'if-none-match': ifNoneMatch }, { etag })) {
      response.code(304);
      return;
    }
    return configuration;
  }
}
