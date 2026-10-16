import { airtimeInstruction } from './airtime-processor-fixture.js';
import type { ServicePayment } from '../../src/modules/payments/domain/payment.js';
import type {
  ServiceProduct,
  ServiceType,
} from '../../src/modules/service-catalog/domain/service-product.js';
import {
  formatVtpassNaira,
  vtpassRequestId,
  formatVtpassPhoneNumber,
} from '../../src/modules/payments/adapters/vtpass-airtime.protocol.js';

/** Explicit fake credentials and a retained provider account route; tests never read deployment settings or connect to VTpass. */
export const vtpassServiceSettings = Object.freeze({
  environment: 'sandbox' as const,
  providerKey: 'test-vtpass:merchant-a',
  apiKey: 'test-api-key',
  secretKey: 'test-secret-key',
  publicKey: 'test-public-key',
});

/** Categories with compatible current first-party inputs; merchant is an explicitly reviewed test protocol, not an assertion about a published VTpass merchant. */
export const serviceProcessorCases = [
  'data',
  'tv',
  'electricity',
  'education',
  'insurance',
  'merchant',
] as const;

/** Build one reserved instruction with service-appropriate immutable recipient snapshots and a contact deliberately distinct from those recipients. */
export function serviceInstruction(
  serviceType: (typeof serviceProcessorCases)[number],
): ServicePayment {
  const original = airtimeInstruction(vtpassServiceSettings.providerKey);
  const quote = {
    ...original.quote,
    serviceType,
    contactPhoneNumber: '+2348099999999',
    recipientPhoneNumber: serviceType === 'data' ? '+2348012345678' : null,
    networkCode: serviceType === 'data' ? 'mtn' : null,
    providerProductCode: {
      data: 'mtn-data:mtn-test-plan',
      tv: 'dstv:dstv-padi',
      electricity: 'ikeja-electric',
      education: 'jamb:utme-no-mock',
      insurance: 'personal-accident-insurance:option-a',
      merchant: 'reviewed-merchant',
    }[serviceType],
    billerCode: {
      data: null,
      tv: 'dstv',
      electricity: 'ikedc',
      education: 'jamb',
      insurance: 'personal-accident-insurance',
      merchant: 'reviewed-merchant',
    }[serviceType],
    electricityMeterType:
      serviceType === 'electricity' ? ('prepaid' as const) : null,
    educationPaymentType:
      serviceType === 'education' ? ('voucher' as const) : null,
    educationPurpose: serviceType === 'education' ? 'Exam registration' : null,
    merchantRecipientIdentifier:
      serviceType === 'merchant' ? '001-invoice-reference' : null,
  };
  const accountValidation = {
    id: original.id,
    ownerId: original.ownerId,
    productId: quote.productId,
    serviceType: serviceType as 'tv' | 'electricity',
    billerCode: quote.billerCode!,
    electricityMeterType: quote.electricityMeterType,
    accountNumber: '001234567890',
    customerName: 'Test customer',
    serviceAddress: null,
    evidenceReference: 'test-verification',
    verifiedAt: quote.createdAt,
    expiresAt: quote.expiresAt,
  };
  const insuredProfile = {
    fullName: 'Test insured person',
    phoneNumber: '+2348012345678',
    address: 'Test street',
    dateOfBirth: '1990-01-01',
    nextOfKinName: 'Test next of kin',
    nextOfKinPhoneNumber: '+2348011111111',
    occupation: 'Test occupation',
  };
  const insuranceTerms = {
    version: 'test-v1',
    eligibilityMode: 'submission_requirements' as const,
    coverageStartMode: 'provider_assigned' as const,
    coverageSummary: 'Test reviewed terms',
    exclusions: [],
    coverageDurationDays: 365,
    cancellationRefundTerms: 'Test refund terms',
    requiredInsuredFields: [
      'fullName',
      'phoneNumber',
      'address',
      'dateOfBirth',
      'nextOfKinName',
      'nextOfKinPhoneNumber',
      'occupation',
    ] as const,
    optionalInsuredFields: [],
  };
  return {
    ...original,
    quote: {
      ...quote,
      accountValidation:
        serviceType === 'tv' || serviceType === 'electricity'
          ? accountValidation
          : null,
      educationValidation:
        serviceType === 'education'
          ? {
              id: original.id,
              ownerId: original.ownerId,
              productId: quote.productId,
              institutionCode: 'jamb',
              paymentType: 'voucher',
              purpose: 'Exam registration',
              beneficiaryIdentifier: '0123456789',
              beneficiaryName: 'Test candidate',
              evidenceReference: 'test-candidate',
              verifiedAt: quote.createdAt,
              expiresAt: quote.expiresAt,
            }
          : null,
      insuranceTerms: serviceType === 'insurance' ? insuranceTerms : null,
      insuranceApplication:
        serviceType === 'insurance'
          ? {
              id: original.id,
              ownerId: original.ownerId,
              productId: quote.productId,
              insuredProfile,
              termsVersion: insuranceTerms.version,
              acceptedTerms: true,
              coverageStartsOn: '2030-01-01',
              coverageEndsOn: '2031-01-01',
              evidenceReference: 'test-submission-requirements',
              createdAt: quote.createdAt,
              expiresAt: quote.expiresAt,
            }
          : null,
    },
  };
}

/** Construct an operator-owned product corresponding to the fixture, never an enabled deployment catalogue entry. */
export function serviceProduct(payment: ServicePayment): ServiceProduct {
  const quote = payment.quote;
  const variable =
    quote.serviceType === 'electricity' || quote.serviceType === 'merchant';
  return {
    id: quote.productId,
    serviceType: quote.serviceType,
    networkCode: quote.networkCode,
    billerCode: quote.billerCode,
    electricityMeterType: quote.electricityMeterType,
    bankId: null,
    bankBeneficiaryValidationLifetimeSeconds: null,
    accountValidationLifetimeSeconds: quote.accountValidation ? 300 : null,
    educationPaymentType: quote.educationPaymentType,
    educationPurpose: quote.educationPurpose,
    educationValidationLifetimeSeconds:
      quote.serviceType === 'education' ? 300 : null,
    educationRecipientVerificationRequired:
      quote.serviceType !== 'education' || quote.educationValidation !== null,
    insuranceTerms: quote.insuranceTerms,
    insuranceApplicationLifetimeSeconds: quote.insuranceApplication
      ? 300
      : null,
    displayName: quote.displayName,
    currency: quote.principal.currency,
    fixedPriceMinorUnits: variable ? null : quote.principal.amountMinorUnits,
    minimumAmountMinorUnits: variable ? 100n : quote.principal.amountMinorUnits,
    maximumAmountMinorUnits: variable
      ? 1_000_000n
      : quote.principal.amountMinorUnits,
    amountStepMinorUnits: 1n,
    feeMinorUnits: quote.feeMinorUnits,
    allowanceLabel: quote.serviceType === 'data' ? 'Test plan' : null,
    validitySeconds: quote.serviceType === 'data' ? 86_400 : null,
    quoteLifetimeSeconds: 300,
    providerKey: quote.providerKey,
    providerProductCode: quote.providerProductCode,
    isEnabled: true,
  };
}

/** Build documentation-shaped provider financial evidence; generated request IDs and long movement IDs exercise correlation and exact-number parsing. */
export function vtpassServiceDelivered(
  payment: ServicePayment,
): Record<string, unknown> {
  const quote = payment.quote;
  const productName: Partial<Record<ServiceType, string>> = {
    data: 'MTN Data',
    tv: 'DSTV Subscription',
    electricity: 'Ikeja Electric Payment - IKEDC',
    education: quote.educationValidation
      ? 'JAMB PIN VENDING (UTME & Direct Entry)'
      : quote.providerProductCode.startsWith('waec-registration:')
        ? 'WAEC Registration PIN'
        : 'WAEC Result Checker PIN',
    insurance: 'Personal Accident Insurance',
    merchant: 'Reviewed merchant fixture',
  };
  const transactionType: Partial<Record<ServiceType, string>> = {
    data: 'Data Services',
    tv: 'TV Subscription',
    electricity: 'Electricity Bill',
    education: 'Education',
    insurance: 'Insurance',
    merchant: 'Other Services',
  };
  const recipient =
    quote.accountValidation?.accountNumber ??
    quote.educationValidation?.beneficiaryIdentifier ??
    quote.insuranceApplication?.insuredProfile.fullName ??
    quote.merchantRecipientIdentifier ??
    formatVtpassPhoneNumber(quote.recipientPhoneNumber!);
  return {
    code: '000',
    requestId: vtpassRequestId(payment),
    amount: formatVtpassNaira(quote.principal.amountMinorUnits),
    content: {
      transactions: {
        status: 'delivered',
        product_name: productName[quote.serviceType],
        type: transactionType[quote.serviceType],
        unique_element: recipient,
        unit_price: formatVtpassNaira(quote.principal.amountMinorUnits),
        amount: formatVtpassNaira(quote.principal.amountMinorUnits),
        quantity: 1,
        transactionId: '17415991578739548187285972',
      },
    },
    ...(quote.serviceType === 'electricity'
      ? {
          token: 'Token : 01234567890123456789',
          kct1: '12345678901234567890',
          kct2: '23456789012345678901',
          units: '79.9 kWh',
          exchangeReference: '001-receipt',
        }
      : {}),
    ...educationDelivery(payment),
    ...(quote.serviceType === 'insurance'
      ? {
          certUrl:
            'https://3rdparty.universalinsuranceonline.com/PrintCertificate.aspx?Data=TESTCERT',
        }
      : {}),
  };
}

/** Keep JAMB, WAEC checker cards and WAEC registration tokens distinct, using their documented response shapes. */
function educationDelivery(payment: ServicePayment): Record<string, unknown> {
  if (payment.quote.serviceType !== 'education') {
    return {};
  }
  if (payment.quote.providerProductCode.startsWith('waec-registration:')) {
    return {
      tokens: ['0012345678901234'],
      purchased_code: 'Token: 0012345678901234',
    };
  }
  if (payment.quote.educationValidation) {
    return { Pin: 'Pin : 0012345678901234' };
  }
  return {
    cards: [{ Pin: '0012345678901234', Serial: 'WRN123' }],
    purchased_code: 'Serial No:WRN123, pin: 0012345678901234',
  };
}
