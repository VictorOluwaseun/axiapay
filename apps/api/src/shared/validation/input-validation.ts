import { BadRequestException, ValidationPipe, type Type } from '@nestjs/common';

/** Build the shared input boundary: reject unknown fields and never coerce credentials, identifiers, or money. */
export function createInputValidationPipe(): ValidationPipe {
  return new ValidationPipe({
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
  });
}

/** Validate untrusted job/CLI/event input against its DTO before mapping it to a service command; invalid input never invokes the operation. */
export async function withValidatedInput<Input extends object, Result>(
  dto: Type<Input>,
  payload: unknown,
  operation: (input: Input) => Result,
): Promise<Awaited<Result>> {
  const input: Input = await createInputValidationPipe().transform(payload, {
    type: 'body',
    metatype: dto,
  });
  return await operation(input);
}
