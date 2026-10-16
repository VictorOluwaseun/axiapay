import type { BillAccountVerificationResult } from '../ports/bill-account-verification.js';
import { verifyVtpassBillAccount } from './vtpass-recipient-verification.js';
import type { AxiosAdapter } from 'axios';
import { PaymentError, type ServicePayment } from '../domain/payment.js';
import type { PaymentTermsInput } from '../ports/service-payment-provider.js';
import type { PaymentFulfilment } from '../domain/payment-fulfilment.js';
import type { VtpassSettings } from './vtpass-client.js';
import { VtpassServiceAdapter } from './vtpass-service.adapter.js';
import { vtpassTvProfiles } from './vtpass-service-profiles.js';

/** Translate explicitly reviewed fixed-bouquet TV purchases; dynamic renewal offers require their own reviewed price contract. */
export class VtpassTvSubscriptionAdapter extends VtpassServiceAdapter {
  /** Bind DSTV, GOTV and Startimes protocol metadata with an isolated transport. */
  constructor(settings: VtpassSettings, transport?: AxiosAdapter) {
    super(settings, vtpassTvProfiles, transport);
  }
  /** Verify the selected recipient using the documented non-purchasing protocol and this adapter's pure compatibility checks. */
  async verify(input: {
    readonly product: import('../../service-catalog/domain/service-product.js').ServiceProduct;
    readonly accountNumber: string;
  }): Promise<BillAccountVerificationResult> {
    this.validate({ scope: 'product', terms: input.product });
    return verifyVtpassBillAccount(this.client, this.settings, input);
  }
  /** Require the owner/product-bound verified smartcard snapshot before representing a TV purchase. */
  protected override validateService(target: PaymentTermsInput): void {
    if (target.scope === 'quote' && !target.terms.accountValidation) {
      throw new PaymentError('INVALID_PAYMENT');
    }
  }
  /** Purchase exactly one selected bouquet; omit top-up amount so DSTV/GOTV cannot reinterpret it as arbitrary wallet credit. */
  protected override requestFields(
    payment: ServicePayment,
    serviceId: string,
  ): Readonly<Record<string, string | undefined>> {
    return {
      billersCode: payment.quote.accountValidation!.accountNumber,
      subscription_type: serviceId === 'startimes' ? undefined : 'change',
      quantity: serviceId === 'startimes' ? undefined : '1',
    };
  }
  /** A smartcard is the service recipient; merchant phone numbers are never substituted for it. */
  protected override recipients(payment: ServicePayment): readonly string[] {
    return [payment.quote.accountValidation!.accountNumber];
  }
  /** Retain the confirmed subscription reference without inventing a renewal date from the payment or prior verification. */
  protected override receipt(
    _response: Record<string, unknown>,
    _payment: ServicePayment,
    reference: string,
  ): PaymentFulfilment {
    return {
      fulfilmentType: 'tv_subscription',
      activationReference: reference,
      renewalAt: null,
    };
  }
}
