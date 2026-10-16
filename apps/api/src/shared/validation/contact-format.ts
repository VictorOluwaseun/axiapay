import { isNumberString, isPhoneNumber, ValidateBy } from 'class-validator';

/** Require unquoted ASCII email local parts while delegating mailbox syntax and length limits to class-validator. */
export const emailValidationOptions = {
  allow_utf8_local_part: false,
  blacklisted_chars: '"',
} as const;

/** Require canonical international digits as well as a valid numbering plan; class-validator's phone parser alone also accepts formatted text and extensions. */
export function isE164PhoneNumber(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('+') &&
    isNumberString(value.slice(1), { no_symbols: true }) &&
    isPhoneNumber(value)
  );
}

/** Apply the shared canonical phone contract at DTO boundaries without normalizing or guessing a country. */
export function IsE164PhoneNumber(): PropertyDecorator {
  return ValidateBy({
    name: 'e164PhoneNumber',
    validator: { validate: isE164PhoneNumber },
  });
}
