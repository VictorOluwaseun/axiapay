import type { Bank } from '../../service-catalog/domain/bank.js';
import { PaymentError } from './payment.js';

/** Independently verified receiving account, bound to the owner, immutable bank and selected transfer pricing/routing revision. */
export interface BankBeneficiaryValidation {
  readonly id: string;
  readonly ownerId: string;
  readonly productId: string;
  readonly bankId: string;
  readonly bankCode: string;
  readonly bankName: string;
  readonly countryCode: string;
  readonly currency: string;
  readonly accountNumber: string;
  readonly accountName: string;
  readonly evidenceReference: string;
  readonly verifiedAt: Date;
  readonly expiresAt: Date;
}

/** Preserve numeric account identifiers and leading zeros; accepted lengths come from the selected bank profile, never a guessed bank prefix. */
export function assertBankAccountNumber(
  accountNumber: string,
  bank: Bank,
): void {
  if (
    typeof accountNumber !== 'string' ||
    !/^[0-9]{1,34}(?![\s\S])/.test(accountNumber) ||
    accountNumber.length < bank.minimumAccountNumberLength ||
    accountNumber.length > bank.maximumAccountNumberLength
  ) {
    throw new PaymentError('INVALID_PAYMENT');
  }
}

/** Prevent expired name-enquiry evidence from authorizing a new transfer quote or hold; accepted held obligations retain their recipient snapshot. */
export function assertBankBeneficiaryCurrent(
  validation: BankBeneficiaryValidation,
  now: Date,
): void {
  if (validation.expiresAt.getTime() <= now.getTime()) {
    throw new PaymentError('BANK_BENEFICIARY_EXPIRED');
  }
}

/** Safe reason classifications describe independently confirmed failure; provider response bodies and ambiguous transport errors stay private. */
export type BankTransferFailureReason =
  | 'bank_rejected'
  | 'recipient_unavailable'
  | 'account_restricted'
  | 'transfer_not_completed';

/** Preserve a bounded final reason or use an honest generic confirmed-failure label; this never turns an uncertain result into failure. */
export function bankTransferFailureReason(
  reason: BankTransferFailureReason | undefined,
): BankTransferFailureReason {
  if (reason === undefined) {
    return 'transfer_not_completed';
  }
  if (
    ![
      'bank_rejected',
      'recipient_unavailable',
      'account_restricted',
      'transfer_not_completed',
    ].includes(reason)
  ) {
    throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
  }
  return reason;
}
