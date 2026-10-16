import { describe, expect, it } from 'vitest';
import { airtimeInstruction } from '../../../../tests/support/airtime-processor-fixture.js';
import { paymentTermsFingerprint } from './payment.js';
import { insuredProfileFingerprint } from './insured-profile-fingerprint.js';

/** Protect historical recovery identities while binding newly accepted delivery and insured facts. */
describe('payment evidence fingerprint compatibility', () => {
  it('retains the legacy Airtime identity when new recipient fields are absent or null', () => {
    const payment = airtimeInstruction();
    const expected = JSON.stringify([
      payment.id,
      payment.quote.productId,
      payment.quote.providerKey,
      payment.quote.providerProductCode,
      '+2348012345678',
      'NGN',
      '10000',
      '50',
    ]);
    expect(paymentTermsFingerprint(payment)).toBe(expected);
    expect(
      paymentTermsFingerprint({
        ...payment,
        quote: {
          ...payment.quote,
          contactPhoneNumber: null,
          merchantRecipientIdentifier: null,
        },
      }),
    ).toBe(expected);
    expect(
      paymentTermsFingerprint({
        ...payment,
        quote: { ...payment.quote, contactPhoneNumber: '+2348099999999' },
      }),
    ).not.toBe(expected);
    expect(
      paymentTermsFingerprint({
        ...payment,
        quote: { ...payment.quote, merchantRecipientIdentifier: '001-invoice' },
      }),
    ).not.toBe(expected);
  });

  it('retains historical insured identities and correlates additional facts independently of JSONB key order', () => {
    const profile = { fullName: 'Test insured', dateOfBirth: '1990-01-01' };
    expect(insuredProfileFingerprint(profile)).toBe(
      JSON.stringify([
        'Test insured',
        '1990-01-01',
        null,
        null,
        null,
        null,
        null,
      ]),
    );
    const extended = {
      ...profile,
      vehicleMake: 'Test make',
      vehicleModel: 'Test model',
      manufactureYear: '2020',
    };
    const reordered = {
      manufactureYear: '2020',
      vehicleModel: 'Test model',
      vehicleMake: 'Test make',
      ...profile,
    };
    expect(insuredProfileFingerprint(extended)).toBe(
      insuredProfileFingerprint(reordered),
    );
    expect(insuredProfileFingerprint(extended)).not.toBe(
      insuredProfileFingerprint({ ...extended, manufactureYear: '2021' }),
    );
  });
});
