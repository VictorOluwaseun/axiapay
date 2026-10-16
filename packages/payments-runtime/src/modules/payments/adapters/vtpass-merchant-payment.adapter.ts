import type { AxiosAdapter } from 'axios';
import { PaymentError, type ServicePayment } from '../domain/payment.js';
import type { PaymentTermsInput } from '../ports/service-payment-provider.js';
import type { VtpassSettings } from './vtpass-client.js';
import { VtpassServiceAdapter } from './vtpass-service.adapter.js';
import type { VtpassServiceProfile } from './vtpass-service-profiles.js';

/** Explicit reviewed merchant protocol mappings; an arbitrary discovered service ID never establishes a supported request/evidence contract. */
export type VtpassMerchantDefinitions = Readonly<
  Record<string, VtpassServiceProfile>
>;

/** Support VTpass merchants using its reviewed billersCode/phone payment envelope. Custom merchant protocols can instead implement the same provider-neutral processor port. */
export class VtpassMerchantPaymentAdapter extends VtpassServiceAdapter {
  /** Require explicit service-specific evidence mappings; VTpass publishes no universal merchant purchase schema to safely enable by default. */
  constructor(
    settings: VtpassSettings,
    definitions: VtpassMerchantDefinitions,
    transport?: AxiosAdapter,
  ) {
    super(settings, definitions, transport);
  }
  /** Require an explicit reviewed account or invoice, independently of delivery contact and without claiming account verification. */
  protected override validateService(target: PaymentTermsInput): void {
    if (target.scope === 'quote' && !target.terms.merchantRecipientIdentifier) {
      throw new PaymentError('INVALID_PAYMENT');
    }
  }
  /** Translate the reviewed merchant recipient and variable or fixed accepted principal; no client-supplied provider key is used. */
  protected override requestFields(
    payment: ServicePayment,
  ): Readonly<Record<string, string>> {
    return {
      billersCode: payment.quote.merchantRecipientIdentifier!,
      amount: this.amount(payment),
    };
  }
  /** Final evidence must identify the reviewed merchant account or invoice, not the merchant's or payer's contact phone. */
  protected override recipients(payment: ServicePayment): readonly string[] {
    return [payment.quote.merchantRecipientIdentifier!];
  }
}
