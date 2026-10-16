import type { BillAccountVerificationResult } from '../ports/bill-account-verification.js';
import { verifyVtpassBillAccount } from './vtpass-recipient-verification.js';
import type { AxiosAdapter } from 'axios';
import { PaymentError, type ServicePayment } from '../domain/payment.js';
import type { PaymentTermsInput } from '../ports/service-payment-provider.js';
import type {
  ElectricityToken,
  PaymentFulfilment,
} from '../domain/payment-fulfilment.js';
import type { VtpassSettings } from './vtpass-client.js';
import { VtpassServiceAdapter } from './vtpass-service.adapter.js';
import { vtpassElectricityProfiles } from './vtpass-service-profiles.js';
import { vtpassEvidenceText } from './vtpass-purchase.protocol.js';

/** Translate both electricity meter modes, keeping ordered prepaid/KCT tokens distinct from postpaid payment receipts. */
export class VtpassElectricityAdapter extends VtpassServiceAdapter {
  /** Bind documented DISCO protocols; the selected catalogue revision fixes the meter mode. */
  constructor(settings: VtpassSettings, transport?: AxiosAdapter) {
    super(settings, vtpassElectricityProfiles, transport);
  }
  /** Verify the selected recipient using the documented non-purchasing protocol and this adapter's pure compatibility checks. */
  async verify(input: {
    readonly product: import('../../service-catalog/domain/service-product.js').ServiceProduct;
    readonly accountNumber: string;
  }): Promise<BillAccountVerificationResult> {
    this.validate({ scope: 'product', terms: input.product });
    return verifyVtpassBillAccount(this.client, this.settings, input);
  }
  /** Refuse unsupported meter modes and a quote lacking its verified matching meter/account snapshot. */
  protected override validateService(target: PaymentTermsInput): void {
    if (
      !['prepaid', 'postpaid'].includes(target.terms.electricityMeterType ?? '')
    ) {
      throw new PaymentError('INVALID_PAYMENT');
    }
    if (
      target.scope === 'quote' &&
      (!target.terms.accountValidation ||
        target.terms.accountValidation.electricityMeterType !==
          target.terms.electricityMeterType)
    ) {
      throw new PaymentError('INVALID_PAYMENT');
    }
  }
  /** Encode the accepted exact amount and product-owned meter mode; customers cannot override either at submission. */
  protected override requestFields(
    payment: ServicePayment,
  ): Readonly<Record<string, string>> {
    return {
      billersCode: payment.quote.accountValidation!.accountNumber,
      variation_code: payment.quote.electricityMeterType!,
      amount: this.amount(payment),
    };
  }
  /** Require final proof for the verified meter/account number, independently of its delivery contact. */
  protected override recipients(payment: ServicePayment): readonly string[] {
    return [payment.quote.accountValidation!.accountNumber];
  }
  /** Project only actual provider tokens and receipt references. Successful vending may precede token delivery and remains recoverable. */
  protected override receipt(
    response: Record<string, unknown>,
    payment: ServicePayment,
    reference: string,
  ): PaymentFulfilment | undefined {
    const receiptReference =
      response.exchangeReference === undefined
        ? reference
        : vtpassEvidenceText(response.exchangeReference);
    if (payment.quote.electricityMeterType === 'postpaid') {
      return { fulfilmentType: 'electricity_postpaid', receiptReference };
    }
    const recharge = electricityToken(
      response.token ?? response.purchased_code,
      'Recharge token',
    );
    if (!recharge) {
      return undefined;
    }
    const tokens = [
      electricityToken(
        response.kct1 ?? response.resetToken,
        'Key change token 1',
      ),
      electricityToken(
        response.kct2 ?? response.configureToken,
        'Key change token 2',
      ),
      recharge,
    ].filter((token): token is ElectricityToken => token !== undefined);
    const units = response.units;
    if (units === undefined || units === null || units === 'N/A') {
      return {
        fulfilmentType: 'electricity_prepaid',
        receiptReference,
        tokens,
        unitsKilowattHours: null,
      };
    }
    const match =
      typeof units === 'string'
        ? /^((?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?)(?:\s*kWh)?$/.exec(units)
        : null;
    if (!match) {
      throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
    }
    return {
      fulfilmentType: 'electricity_prepaid',
      receiptReference,
      tokens,
      unitsKilowattHours: match[1]!,
    };
  }
}

/** Strip only the documented label while preserving all twenty digits and excluding missing-token sentinels. */
function electricityToken(
  value: unknown,
  label: string,
): ElectricityToken | undefined {
  if (
    value === undefined ||
    value === null ||
    value === '' ||
    value === 'N/A'
  ) {
    return undefined;
  }
  const match =
    typeof value === 'string'
      ? /^(?:Token\s*:\s*)?([0-9]{20})$/i.exec(value)
      : null;
  if (!match) {
    throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
  }
  return { label, value: match[1]! };
}
