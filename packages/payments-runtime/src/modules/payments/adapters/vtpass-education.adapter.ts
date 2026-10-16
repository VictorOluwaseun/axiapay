import type { EducationBeneficiaryResult } from '../ports/education-beneficiary-verification.js';
import { verifyVtpassEducationBeneficiary } from './vtpass-recipient-verification.js';
import { isAsciiDigits } from '../../../shared/domain/numeric-text.js';
import type { AxiosAdapter } from 'axios';
import { PaymentError, type ServicePayment } from '../domain/payment.js';
import type { PaymentTermsInput } from '../ports/service-payment-provider.js';
import type { PaymentFulfilment } from '../domain/payment-fulfilment.js';
import {
  formatVtpassPhoneNumber,
  vtpassObject,
} from './vtpass-airtime.protocol.js';
import type { VtpassSettings } from './vtpass-client.js';
import { VtpassServiceAdapter } from './vtpass-service.adapter.js';
import { vtpassEducationProfiles } from './vtpass-service-profiles.js';
import {
  vtpassEvidenceText,
  vtpassProductSelection,
} from './vtpass-purchase.protocol.js';

/** Translate JAMB candidate-bound PINs and WAEC delivery-phone vouchers without fabricating a candidate-verification API for WAEC. */
export class VtpassEducationAdapter extends VtpassServiceAdapter {
  /** Bind documented education vending protocols; institution-fee adapters remain independently replaceable. */
  constructor(settings: VtpassSettings, transport?: AxiosAdapter) {
    super(settings, vtpassEducationProfiles, transport);
  }
  /** Verify the selected recipient using the documented non-purchasing protocol and this adapter's pure compatibility checks. */
  async verify(input: {
    readonly product: import('../../service-catalog/domain/service-product.js').ServiceProduct;
    readonly beneficiaryIdentifier: string;
  }): Promise<EducationBeneficiaryResult> {
    this.validate({ scope: 'product', terms: input.product });
    return verifyVtpassEducationBeneficiary(this.client, this.settings, input);
  }
  /** Require the product's actual recipient-preparation model and reject unsupported institution-fee purchases. */
  protected override validateService(target: PaymentTermsInput): void {
    const { serviceId } = vtpassProductSelection(
      target.terms.providerProductCode,
    );
    if (target.terms.educationPaymentType !== 'voucher') {
      throw new PaymentError('PAYMENT_UNAVAILABLE', {
        reason: 'PRODUCT_NOT_SUPPORTED',
      });
    }
    if (
      target.scope === 'product' &&
      (target.terms.educationRecipientVerificationRequired !== false) !==
        (serviceId === 'jamb')
    ) {
      throw new PaymentError('PAYMENT_UNAVAILABLE', {
        reason: 'PRODUCT_NOT_SUPPORTED',
      });
    }
    if (
      target.scope === 'quote' &&
      (serviceId === 'jamb') !== (target.terms.educationValidation !== null)
    ) {
      throw new PaymentError('INVALID_PAYMENT');
    }
    if (
      target.scope === 'quote' &&
      serviceId !== 'jamb' &&
      target.terms.contactPhoneNumber &&
      target.terms.contactPhoneNumber !== target.terms.recipientPhoneNumber
    ) {
      throw new PaymentError('INVALID_PAYMENT');
    }
    if (
      target.scope === 'quote' &&
      serviceId !== 'jamb' &&
      !target.terms.recipientPhoneNumber
    ) {
      throw new PaymentError('INVALID_PAYMENT');
    }
  }
  /** Only JAMB takes a candidate profile ID; WAEC PINs are delivered to the explicitly reviewed phone. */
  protected override requestFields(
    payment: ServicePayment,
  ): Readonly<Record<string, string | undefined>> {
    if (payment.quote.educationValidation) {
      return {
        billersCode: payment.quote.educationValidation.beneficiaryIdentifier,
      };
    }
    return {
      phone: formatVtpassPhoneNumber(payment.quote.recipientPhoneNumber!),
      quantity: '1',
    };
  }
  /** Correlate JAMB to its verified profile and WAEC to its reviewed delivery phone, preserving leading zeros. */
  protected override recipients(payment: ServicePayment): readonly string[] {
    if (payment.quote.educationValidation) {
      return [payment.quote.educationValidation.beneficiaryIdentifier];
    }
    const phone = payment.quote.recipientPhoneNumber!;
    return [formatVtpassPhoneNumber(phone), phone, phone.slice(1)];
  }
  /** Retain exactly one delivered voucher; missing PINs remain pending fulfilment rather than causing another purchase. */
  protected override receipt(
    response: Record<string, unknown>,
    payment: ServicePayment,
  ): PaymentFulfilment | undefined {
    const { serviceId } = vtpassProductSelection(
      payment.quote.providerProductCode,
    );
    if (serviceId === 'jamb') {
      return this.jambReceipt(response);
    }
    if (serviceId === 'waec-registration') {
      return this.registrationReceipt(response);
    }
    if (response.cards === undefined) {
      return undefined;
    }
    if (!Array.isArray(response.cards) || response.cards.length !== 1) {
      throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
    }
    const card = vtpassObject(response.cards[0]);
    return {
      fulfilmentType: 'education_voucher',
      voucherCode: voucherDigits(card.Pin, /^Pin\s*:\s*/i),
      serialNumber:
        card.Serial === undefined ? null : vtpassEvidenceText(card.Serial),
    };
  }
  /** Project a documented JAMB PIN without losing zeros or inferring voucher delivery from financial success alone. */
  private jambReceipt(
    response: Record<string, unknown>,
  ): PaymentFulfilment | undefined {
    const supplied = [response.Pin, response.purchased_code].filter(
      (value) => value !== undefined && value !== '',
    );
    if (supplied.length === 0) {
      return undefined;
    }
    const codes = supplied.map((value) => voucherDigits(value, /^Pin\s*:\s*/i));
    if (new Set(codes).size !== 1) {
      throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
    }
    return {
      fulfilmentType: 'education_voucher',
      voucherCode: codes[0]!,
      serialNumber: null,
    };
  }

  /** Preserve the separate WAEC registration token-array protocol and its leading zeros. */
  private registrationReceipt(
    response: Record<string, unknown>,
  ): PaymentFulfilment | undefined {
    if (response.tokens === undefined) {
      return undefined;
    }
    if (!Array.isArray(response.tokens) || response.tokens.length !== 1) {
      throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
    }
    const code = voucherDigits(response.tokens[0], /^Token\s*:\s*/i);
    if (
      response.purchased_code !== undefined &&
      response.purchased_code !== '' &&
      voucherDigits(response.purchased_code, /^Token\s*:\s*/i) !== code
    ) {
      throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
    }
    return {
      fulfilmentType: 'education_voucher',
      voucherCode: code,
      serialNumber: null,
    };
  }
}

/** Strip only a documented provider label; PINs/tokens are exact strings and never parsed as numbers. */
function voucherDigits(value: unknown, prefix: RegExp): string {
  const code = vtpassEvidenceText(value).replace(prefix, '');
  if (code.length < 4 || code.length > 100 || !isAsciiDigits(code)) {
    throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
  }
  return code;
}
