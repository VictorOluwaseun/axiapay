import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { HttpErrorResponse } from './http-failure.js';

/** Describe the common public HTTP failure envelope; feature codes and messages remain documented by each operation. */
export class HttpErrorResponseDto implements HttpErrorResponse {
  @ApiProperty({ example: 400, minimum: 400, maximum: 599 })
  statusCode!: number;

  @ApiProperty({ example: 'INVALID_INPUT' })
  code!: string;

  @ApiProperty({ example: 'Invalid request.' })
  message!: string;

  @ApiProperty({
    description:
      'Server-generated diagnostic reference, also returned in X-Request-Id.',
  })
  requestId!: string;

  @ApiPropertyOptional({
    description: 'Minimum delay before retrying, also returned in Retry-After.',
    minimum: 0,
  })
  retryAfterSeconds?: number;
}
