import { ValidateBy, type ValidationArguments } from 'class-validator';

/** Count Unicode code points exactly, including variation selectors, without trimming or rewriting a credential. */
export function IsCodePointLength(
  minimum: number,
  maximum: number,
): PropertyDecorator {
  return ValidateBy({
    name: 'codePointLength',
    constraints: [minimum, maximum],
    validator: {
      /** Apply the password's exact code-point bounds without conversion. */
      validate: (value: unknown) => {
        if (typeof value !== 'string') {
          return false;
        }
        const length = Array.from(value).length;
        return length >= minimum && length <= maximum;
      },
    },
  });
}

/** Accept readable text with some non-whitespace content while rejecting control characters; preserve intentional spaces. */
export function IsReadableText(): PropertyDecorator {
  return ValidateBy({
    name: 'readableText',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' &&
        value.trim().length > 0 &&
        !/\p{Cc}/u.test(value),
    },
  });
}

/** Require an explicit canonical boundary for display labels or references whose surrounding whitespace is invalid. */
export function IsUnpaddedText(): PropertyDecorator {
  return ValidateBy({
    name: 'unpaddedText',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' && value.length > 0 && value.trim() === value,
    },
  });
}

/** Require one input selector before workflows resolve its business meaning against a stored product. */
export function HasExactlyOneField(
  fields: readonly string[],
): PropertyDecorator {
  return ValidateBy({
    name: 'exactlyOneField',
    constraints: [...fields],
    validator: {
      /** Count effective supplied selectors, leaving each field's own DTO constraints responsible for its format. */
      validate: (_value: unknown, arguments_?: ValidationArguments) => {
        const input = arguments_?.object as Record<string, unknown>;
        return (
          fields.filter((field) => input[field] !== undefined).length === 1
        );
      },
    },
  });
}
