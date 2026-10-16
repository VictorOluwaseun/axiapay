/** Verify exact pricing invariants and explicit pending/exception states independently of HTTP, storage and providers. */
import { describe, expect, it } from 'vitest';
import { maximumMinorUnits } from '@axiapay/payments-runtime/modules/wallets/domain/money';
import {
  assertConversionOffer,
  calculateConversionAmounts,
  conversionStatus,
  type ConversionOffer,
  type ConversionRequest,
} from './conversion.js';

/** Selected fixture terms are test-only and never configured by runtime composition. */
const offer: ConversionOffer = {
  id: 'test-network-airtime',
  displayName: 'Test network conversion',
  networkCode: 'test-network',
  currency: 'NGN',
  termsVersion: 'test-v1',
  rateNumerator: 4n,
  rateDenominator: 5n,
  fixedFeeMinorUnits: 100n,
  feeBasisPoints: 125,
  minimumAirtimeMinorUnits: 1000n,
  maximumAirtimeMinorUnits: 1000000n,
  airtimeStepMinorUnits: 1n,
  quoteValiditySeconds: 300,
  transferWindowSeconds: 900,
};

describe('airtime conversion pricing', () => {
  it('discloses gross credit, rounded proportional fee and net proceeds separately', () => {
    const amounts = calculateConversionAmounts(offer, 100001n);
    expect(amounts.grossCreditValue.amountMinorUnits).toBe(80000n);
    expect(amounts.feeMinorUnits).toBe(1100n);
    expect(amounts.netCreditValue.amountMinorUnits).toBe(78900n);
  });
  it('rounds the gross down and fee up without using floating point', () => {
    const amounts = calculateConversionAmounts(
      {
        ...offer,
        rateNumerator: 2n,
        rateDenominator: 3n,
        fixedFeeMinorUnits: 0n,
        feeBasisPoints: 1,
      },
      1001n,
    );
    expect(amounts.grossCreditValue.amountMinorUnits).toBe(667n);
    expect(amounts.feeMinorUnits).toBe(1n);
    expect(amounts.netCreditValue.amountMinorUnits).toBe(666n);
  });
  it('preserves precision beyond Number.MAX_SAFE_INTEGER and at the SQL bigint limit', () => {
    const exactOffer = {
      ...offer,
      rateNumerator: 1n,
      rateDenominator: 1n,
      fixedFeeMinorUnits: 0n,
      feeBasisPoints: 0,
      maximumAirtimeMinorUnits: maximumMinorUnits,
    };
    expect(
      calculateConversionAmounts(exactOffer, maximumMinorUnits).netCreditValue
        .amountMinorUnits,
    ).toBe(maximumMinorUnits);
    expect(
      calculateConversionAmounts(exactOffer, 9007199254740993n).netCreditValue
        .amountMinorUnits,
    ).toBe(9007199254740993n);
  });
  it.each([999n, 1000001n, 1001n])(
    'rejects out-of-range or unsupported step face value %s',
    (amount) => {
      expect(() =>
        calculateConversionAmounts(
          { ...offer, airtimeStepMinorUnits: 100n },
          amount,
        ),
      ).toThrow('AIRTIME_INELIGIBLE');
    },
  );
  it.each([
    { rateNumerator: 0n },
    { rateDenominator: 0n },
    { fixedFeeMinorUnits: -1n },
    { feeBasisPoints: 0.1 },
    { feeBasisPoints: 10001 },
    { airtimeStepMinorUnits: 0n },
    { minimumAirtimeMinorUnits: 0n },
    { quoteValiditySeconds: 0 },
    { transferWindowSeconds: 86401 },
    { displayName: 'Bad\u0000name' },
    { fixedFeeMinorUnits: 800n },
    { rateNumerator: maximumMinorUnits },
  ])('fails closed on invalid configuration %o', (overrides) => {
    expect(() => assertConversionOffer({ ...offer, ...overrides })).toThrow();
  });
  it('accepts exact boundary terms that preserve a positive net amount', () => {
    expect(() =>
      assertConversionOffer({ ...offer, fixedFeeMinorUnits: 789n }),
    ).not.toThrow();
  });
});

describe('airtime conversion state', () => {
  /** Only progress fields are needed by this pure state policy. */
  const request = {
    operationId: null,
    hasPostingConflict: false,
    outcome: null,
    instructions: { instructionReference: 'test' },
    receiveBy: new Date('2026-10-14T10:00:00Z'),
  } as ConversionRequest;
  it('keeps an elapsed window awaiting independent verification without rejecting the conversion', () => {
    expect(conversionStatus(request, new Date('2026-10-14T10:01:00Z'))).toBe(
      'verification_pending',
    );
  });
  it('does not present a verified receipt as posted wallet credit', () => {
    expect(
      conversionStatus({
        ...request,
        outcome: { outcome: 'verified' },
      } as ConversionRequest),
    ).toBe('credit_pending');
  });
  it('retains exceptions after deadlines and separates committed credit', () => {
    expect(conversionStatus({ ...request, hasPostingConflict: true })).toBe(
      'exception',
    );
    expect(
      conversionStatus({
        ...request,
        outcome: { outcome: 'exception' },
      } as ConversionRequest),
    ).toBe('exception');
    expect(conversionStatus({ ...request, operationId: 'journal-id' })).toBe(
      'credited',
    );
  });
});
