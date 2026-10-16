import type { ServiceProduct } from '../../service-catalog/domain/service-product.js';
import { PaymentError } from '../domain/payment.js';
import type { BillAccountVerificationResult } from '../ports/bill-account-verification.js';
import type { EducationBeneficiaryResult } from '../ports/education-beneficiary-verification.js';
import { vtpassObject } from './vtpass-airtime.protocol.js';
import { VtpassClient, type VtpassSettings } from './vtpass-client.js';
import {
  vtpassEvidenceText,
  vtpassObservationReference,
  vtpassProductSelection,
} from './vtpass-purchase.protocol.js';

/** Verify an explicitly selected smartcard or meter without purchasing; only the bound HTTP observation can supply customer details. */
export async function verifyVtpassBillAccount(
  client: VtpassClient,
  settings: VtpassSettings,
  input: { readonly product: ServiceProduct; readonly accountNumber: string },
): Promise<BillAccountVerificationResult> {
  const { serviceId } = vtpassProductSelection(
    input.product.providerProductCode,
  );
  const response = await client.post(
    '/api/merchant-verify',
    JSON.stringify({
      serviceID: serviceId,
      billersCode: input.accountNumber,
      ...(input.product.serviceType === 'electricity'
        ? { type: input.product.electricityMeterType }
        : {}),
    }),
  );
  const identity = {
    productId: input.product.id,
    accountNumber: input.accountNumber,
    billerCode: input.product.billerCode!,
    electricityMeterType: input.product.electricityMeterType,
  };
  if (['011', '016'].includes(String(response.code))) {
    return { ...identity, verificationStatus: 'invalid' };
  }
  if (response.code !== '000') {
    return { ...identity, verificationStatus: 'pending' };
  }
  const content = vtpassObject(response.content);
  if (content.WrongBillersCode === true || content.Can_Vend === 'no') {
    return { ...identity, verificationStatus: 'invalid' };
  }
  const meterNumber =
    content.Meter_Number === undefined
      ? content.MeterNumber
      : content.Meter_Number;
  if (
    input.product.serviceType === 'electricity' &&
    meterNumber !== undefined &&
    meterNumber !== input.accountNumber
  ) {
    throw new PaymentError('INVALID_PROVIDER_EVIDENCE', {
      reason: 'PROVIDER_RECIPIENT_MISMATCH',
    });
  }
  if (
    input.product.serviceType === 'electricity' &&
    content.Meter_Type !== undefined &&
    content.Meter_Type !== input.product.electricityMeterType?.toUpperCase()
  ) {
    throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
  }
  return {
    ...identity,
    verificationStatus: 'verified',
    customerName: vtpassEvidenceText(content.Customer_Name),
    serviceAddress:
      content.Address === undefined || content.Address === ''
        ? null
        : vtpassEvidenceText(content.Address, 500),
    evidenceReference: vtpassObservationReference(
      settings.environment,
      'account',
      [
        input.product.id,
        input.accountNumber,
        input.product.electricityMeterType,
      ],
      response,
    ),
  };
}

/** Verify only JAMB's documented profile lookup; WAEC delivery vouchers have no fabricated candidate verification. */
export async function verifyVtpassEducationBeneficiary(
  client: VtpassClient,
  settings: VtpassSettings,
  input: {
    readonly product: ServiceProduct;
    readonly beneficiaryIdentifier: string;
  },
): Promise<EducationBeneficiaryResult> {
  const selection = vtpassProductSelection(input.product.providerProductCode);
  if (
    selection.serviceId !== 'jamb' ||
    input.product.serviceType !== 'education' ||
    !selection.variationCode
  ) {
    throw new PaymentError('PAYMENT_UNAVAILABLE', {
      reason: 'PRODUCT_NOT_SUPPORTED',
    });
  }
  const response = await client.post(
    '/api/merchant-verify',
    JSON.stringify({
      serviceID: selection.serviceId,
      billersCode: input.beneficiaryIdentifier,
      type: selection.variationCode,
    }),
  );
  const identity = {
    productId: input.product.id,
    institutionCode: input.product.billerCode!,
    beneficiaryIdentifier: input.beneficiaryIdentifier,
  };
  if (['011', '016'].includes(String(response.code))) {
    return { ...identity, verificationStatus: 'invalid' };
  }
  if (response.code !== '000') {
    return { ...identity, verificationStatus: 'pending' };
  }
  const content = vtpassObject(response.content);
  return {
    ...identity,
    verificationStatus: 'verified',
    beneficiaryName: vtpassEvidenceText(content.Customer_Name),
    evidenceReference: vtpassObservationReference(
      settings.environment,
      'education',
      [input.product.id, input.beneficiaryIdentifier, selection.variationCode],
      response,
    ),
  };
}
