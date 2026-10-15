import { Module } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { createInputValidationPipe } from '../shared/validation/input-validation.js';

/** Apply DTO input validation and explicit transformation before HTTP handlers invoke feature services. */
@Module({
  providers: [{ provide: APP_PIPE, useFactory: createInputValidationPipe }],
})
export class RequestValidationModule {}
