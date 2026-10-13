import { BadRequestException, Module, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';

/** Validate class DTOs globally, including nested objects, without coercing credentials or disclosing rejected values. */
@Module({
  providers: [
    {
      provide: APP_PIPE,
      useFactory: () =>
        new ValidationPipe({
          transform: true,
          transformOptions: { enableImplicitConversion: false },
          whitelist: true,
          forbidNonWhitelisted: true,
          forbidUnknownValues: true,
          validationError: { target: false, value: false },
          exceptionFactory: () =>
            new BadRequestException({
              code: 'INVALID_INPUT',
              message: 'Invalid request body.',
            }),
        }),
    },
  ],
})
export class RequestValidationModule {}
