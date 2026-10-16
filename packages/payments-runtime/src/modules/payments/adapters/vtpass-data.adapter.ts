import type { AxiosAdapter } from 'axios';
import { PaymentError, type ServicePayment } from '../domain/payment.js';
import type { PaymentTermsInput } from '../ports/service-payment-provider.js';
import {
  formatVtpassPhoneNumber,
  supportsVtpassPhoneNumber,
} from './vtpass-airtime.protocol.js';
import type { VtpassSettings } from './vtpass-client.js';
import { VtpassServiceAdapter } from './vtpass-service.adapter.js';
import { vtpassDataProfiles } from './vtpass-service-profiles.js';

/** Translate domestic mobile-data plans without deriving network from a phone prefix or coupling the processor to VTpass. */
export class VtpassDataAdapter extends VtpassServiceAdapter {
  /** Bind reviewed VTpass data protocols; product variations and retail terms remain operator-owned catalogue revisions. */
  constructor(settings: VtpassSettings, transport?: AxiosAdapter) {
    super(settings, vtpassDataProfiles, transport);
  }
  /** Data targets an explicitly selected mobile recipient, which may differ from the contact receiving notifications. */
  protected override validateService(target: PaymentTermsInput): void {
    if (
      target.scope === 'quote' &&
      (!target.terms.recipientPhoneNumber ||
        !supportsVtpassPhoneNumber(target.terms.recipientPhoneNumber))
    ) {
      throw new PaymentError('INVALID_PAYMENT', {
        reason: 'NIGERIAN_RECIPIENT_REQUIRED',
      });
    }
  }
  /** Send the recipient in billersCode; VTpass's phone field is a delivery contact, not recipient evidence. */
  protected override requestFields(
    payment: ServicePayment,
  ): Readonly<Record<string, string>> {
    return {
      billersCode: formatVtpassPhoneNumber(payment.quote.recipientPhoneNumber!),
    };
  }
  /** Accept only documented representations of the selected recipient, preserving its network from the catalogue. */
  protected override recipients(payment: ServicePayment): readonly string[] {
    const phone = payment.quote.recipientPhoneNumber!;
    return [formatVtpassPhoneNumber(phone), phone, phone.slice(1)];
  }
}
