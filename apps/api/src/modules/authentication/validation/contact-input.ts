import {
  isEmail,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
  type ValidationArguments,
} from 'class-validator';
import {
  emailValidationOptions,
  isE164PhoneNumber,
} from '../../../shared/validation/contact-format.js';

/** Normalize only declared contact strings at an adapter boundary; numeric or structured credentials remain invalid. */
export function canonicalContactValue(value: unknown, kind: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  return kind === 'email' ? value.trim().toLowerCase() : value.trim();
}

/** Validate the DTO's declared contact channel before any service or rate-limit lookup. */
@ValidatorConstraint({ name: 'contactValue', async: false })
export class ContactValueConstraint implements ValidatorConstraintInterface {
  /** Delegate channel formats to the shared boundary contracts without changing mailbox aliases or guessing a country. */
  validate(value: unknown, arguments_: ValidationArguments): boolean {
    const kind = (arguments_.object as { kind?: unknown }).kind;
    if (kind === 'phone') {
      return isE164PhoneNumber(value);
    }
    return kind === 'email' && isEmail(value, emailValidationOptions);
  }
}
