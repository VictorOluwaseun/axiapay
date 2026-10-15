import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { HttpExceptionFilter } from '../shared/http/http-exception.filter.js';

/** Install the shared HTTP failure boundary for unmatched routes, parser errors, and controllers without a feature mapper. */
@Module({
  providers: [{ provide: APP_FILTER, useClass: HttpExceptionFilter }],
})
export class HttpErrorHandlingModule {}
