import {
  ValidatorConstraint,
  type ValidatorConstraintInterface,
  type ValidationArguments,
} from 'class-validator';

/** Normalize only declared contact strings at an adapter boundary; numeric or structured credentials remain invalid. */
export function canonicalContactValue(value: unknown, kind: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  return kind === 'email' ? value.trim().toLowerCase() : value.trim();
}

/** Validate a DTO's channel-specific contact, or an explicitly declared email field, before any service or rate-limit lookup. */
@ValidatorConstraint({ name: 'contactValue', async: false })
export class ContactValueConstraint implements ValidatorConstraintInterface {
  /** Check canonical email or international phone syntax without changing mailbox aliases or guessing a country. */
  validate(value: unknown, arguments_: ValidationArguments): boolean {
    if (typeof value !== 'string') {
      return false;
    }
    const kind: unknown =
      arguments_.constraints?.[0] ??
      (arguments_.object as { kind?: unknown }).kind;
    if (kind === 'phone') {
      return /^\+[1-9]\d{7,14}(?![\s\S])/.test(value);
    }
    if (
      kind !== 'email' ||
      value.length > 254 ||
      !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+(?![\s\S])/.test(
        value,
      )
    ) {
      return false;
    }
    const localPart = value.split('@')[0] ?? '';
    return (
      localPart.length <= 64 &&
      !localPart.startsWith('.') &&
      !localPart.endsWith('.') &&
      !localPart.includes('..')
    );
  }
}
