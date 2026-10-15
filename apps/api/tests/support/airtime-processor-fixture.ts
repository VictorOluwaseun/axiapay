import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import {
  paymentTermsFingerprint,
  type ServicePayment,
} from '../../src/modules/payments/domain/payment.js';
import type { AirtimeProcessorAdapter } from '../../src/modules/payments/ports/airtime-processor-adapter.js';
import type { ProviderPaymentResult } from '../../src/modules/payments/ports/service-payment-provider.js';
import { money } from '../../src/modules/wallets/domain/money.js';

/** Test-only wire format demonstrates exact value and merchant identity translation without implying a real provider protocol. */
export interface TestAirtimeRequest {
  readonly merchantReference: string;
  readonly productCode: string;
  readonly recipient: string;
  readonly amountMinorUnits: string;
  readonly currency: string;
  readonly termsFingerprint: string;
}

/** Test-only upstream envelope, deliberately different from our submission contract. */
export interface TestAirtimeResponse {
  readonly observation: ProviderPaymentResult;
}

/** Build an already-reserved first-party instruction; this fixture neither posts money nor contacts a provider. */
export function airtimeInstruction(
  providerKey = 'test-airtime:merchant-a',
): ServicePayment {
  const now = new Date('2030-01-01T00:00:00Z');
  const ownerId = randomUUID();
  return {
    id: randomUUID(),
    ownerId,
    requestKey: randomUUID(),
    partnerAccountId: randomUUID(),
    feeAccountId: null,
    createdAt: now,
    submissionStartedAt: now,
    reservationId: randomUUID(),
    reservationStatus: 'reserved',
    outcome: null,
    fulfilment: null,
    documents: [],
    quote: {
      id: randomUUID(),
      ownerId,
      walletId: randomUUID(),
      productId: randomUUID(),
      serviceType: 'airtime',
      networkCode: 'test-network',
      billerCode: null,
      electricityMeterType: null,
      accountValidation: null,
      bankBeneficiaryValidation: null,
      narration: null,
      educationValidation: null,
      insuranceApplication: null,
      educationPaymentType: null,
      educationPurpose: null,
      insuranceTerms: null,
      displayName: 'Test airtime',
      recipientPhoneNumber: '+2348012345678',
      principal: money(10_000n, 'NGN'),
      feeMinorUnits: 50n,
      totalDebitMinorUnits: 10_050n,
      allowanceLabel: null,
      validitySeconds: null,
      providerKey,
      providerProductCode: 'test-airtime-product',
      createdAt: now,
      expiresAt: new Date(now.getTime() + 300_000),
    },
  };
}

/** Return a correlated unresolved observation without manufacturing fulfilment or final failure. */
export function pendingAirtimeSubmission(
  payment: ServicePayment,
): ProviderPaymentResult {
  return {
    paymentId: payment.id,
    termsFingerprint: paymentTermsFingerprint(payment),
    outcome: 'pending',
  };
}

/** Injectable test-only protocol adapter with independently controllable stages; never imported by production composition. */
export function testAirtimeAdapter(providerKey = 'test-airtime:merchant-a') {
  return {
    providerKey,
    /** Translate only into the test protocol, preserving exact minor units. */
    toRequest: vi.fn((payment: ServicePayment): TestAirtimeRequest => ({
      merchantReference: payment.id,
      productCode: payment.quote.providerProductCode,
      recipient: payment.quote.recipientPhoneNumber!,
      amountMinorUnits: payment.quote.principal.amountMinorUnits.toString(),
      currency: payment.quote.principal.currency,
      termsFingerprint: paymentTermsFingerprint(payment),
    })),
    /** Simulate an unresolved provider response for the same merchant identity. */
    execute: vi.fn(
      async (request: TestAirtimeRequest): Promise<TestAirtimeResponse> => ({
        observation: {
          paymentId: request.merchantReference,
          termsFingerprint: request.termsFingerprint,
          outcome: 'pending',
        },
      }),
    ),
    /** Check the test merchant identity before unwrapping; real adapters must authenticate their actual provider responses. */
    toSubmission: vi.fn(
      (
        response: TestAirtimeResponse,
        payment: ServicePayment,
      ): ProviderPaymentResult => {
        if (response.observation.paymentId !== payment.id) {
          throw new Error('Mismatched test merchant identity');
        }
        return response.observation;
      },
    ),
    /** Enquire without executing the purchase stage. */
    lookup: vi.fn(async (payment: ServicePayment) =>
      pendingAirtimeSubmission(payment),
    ),
  } satisfies AirtimeProcessorAdapter<TestAirtimeRequest, TestAirtimeResponse>;
}
