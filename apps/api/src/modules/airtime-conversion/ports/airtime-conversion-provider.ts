import type { Money } from '@axiapay/payments-runtime/modules/wallets/domain/money';
import type {
  ConversionOffer,
  TransferInstructions,
} from '../domain/conversion.js';

/** Non-financial source eligibility; an eligible response must be authoritative for this phone, product and face value. */
export interface ConversionEligibilityInput {
  readonly providerProductCode: string;
  readonly sourcePhoneNumber: string;
  readonly networkCode: string;
  readonly airtimeValue: Money;
}

/** Exact accepted intent; preparation issues instructions only and must never initiate an airtime transfer itself. */
export interface ConversionTransferInput extends ConversionEligibilityInput {
  readonly conversionId: string;
  readonly requestFingerprint: string;
  readonly eligibilityReference: string;
  readonly netCreditValue: Money;
  readonly acceptedAt: Date;
  readonly receiveBy: Date;
}

/** Canonical cleared receipt from authenticated server lookup. Sender assertions and SMS delivery are insufficient. */
export interface VerifiedAirtimeReceipt {
  readonly conversionId: string;
  readonly requestFingerprint: string;
  readonly externalMovementId: string;
  readonly evidenceReference: string;
  readonly sourcePhoneNumber: string;
  readonly networkCode: string;
  readonly receivingPhoneNumber: string;
  readonly instructionReference: string;
  readonly airtimeValue: Money;
  readonly netCreditValue: Money;
  readonly receivedAt: Date;
}

/** Authenticated lookup may recover lost instructions. Timeouts throw; pending never implies failed receipt. */
export type ConversionInspection = {
  readonly conversionId: string;
  readonly requestFingerprint: string;
  readonly instructions: TransferInstructions | null;
} & (
  | { readonly receiptStatus: 'pending' }
  | {
      readonly receiptStatus: 'received';
      readonly receipt: VerifiedAirtimeReceipt;
    }
  | {
      readonly receiptStatus: 'verification_failed';
      readonly evidenceReference: string;
    }
);

/** Provider-neutral capability port. Adapters own credentials, authenticated evidence and protocol translation, never wallet credit. */
export interface AirtimeConversionProvider {
  /** Check the source without moving airtime or creating a conversion; unsupported eligibility returns a safe negative result. */
  checkEligibility(input: ConversionEligibilityInput): Promise<
    | { readonly isEligible: false }
    | {
        readonly isEligible: true;
        readonly eligibilityReference: string;
        readonly expiresAt: Date;
      }
  >;
  /** Called at most once after durable acceptance and claim. Uncertainty is recovered with inspectTransfer, never a new submission. */
  prepareTransfer(
    input: ConversionTransferInput,
  ): Promise<ConversionInspection>;
  /** Look up the original logical identity, including its complete fingerprint, without executing or substituting a transfer. */
  inspectTransfer(
    input: ConversionTransferInput,
  ): Promise<ConversionInspection>;
}

/** Explicit composition binding; accepted work retains this realm and clearing account even when new offers are withdrawn. */
export interface ConversionRoute {
  readonly providerId: string;
  readonly partnerAccountId: string;
  readonly provider: AirtimeConversionProvider;
  readonly acceptsNewRequests: boolean;
  readonly offers: readonly (ConversionOffer & {
    readonly providerProductCode: string;
  })[];
}
