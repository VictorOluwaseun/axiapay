import type { ElectricityMeterType } from '../../service-catalog/domain/service-product.js';
import { PaymentError } from './payment.js';

/** Server-verified recipient snapshot, scoped to the customer and immutable product; no validation result authorizes spending. */
export interface BillAccountValidation {
  readonly id: string;
  readonly ownerId: string;
  readonly productId: string;
  readonly serviceType: 'tv' | 'electricity';
  readonly billerCode: string;
  readonly electricityMeterType: ElectricityMeterType | null;
  readonly accountNumber: string;
  readonly customerName: string;
  readonly serviceAddress: string | null;
  readonly evidenceReference: string;
  readonly verifiedAt: Date;
  readonly expiresAt: Date;
}

/** Require bounded readable verified details; control characters and empty names are not valid customer-facing evidence. */
export function assertBillDisplayText(
  value: string,
  maximumLength: number,
): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximumLength ||
    !value.trim() ||
    hasBillControlCharacters(value)
  ) {
    throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
  }
}

/** Detect unsafe control characters while retaining printable Unicode customer names and addresses. */
function hasBillControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint < 32 || codePoint === 127;
  });
}

/** Prevent an old verified recipient from authorizing fresh terms; held obligations retain their original recovery snapshot. */
export function assertBillAccountCurrent(
  validation: BillAccountValidation,
  now: Date,
): void {
  if (validation.expiresAt.getTime() <= now.getTime()) {
    throw new PaymentError('ACCOUNT_VALIDATION_EXPIRED');
  }
}
