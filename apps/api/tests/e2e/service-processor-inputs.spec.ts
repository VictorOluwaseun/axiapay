import { InsuranceOptionsQueryDto } from '../../src/modules/payments/dtos/insurance-options.dto.js';
/** Verify new first-party service fields at the same validation boundary used by HTTP, before any financial workflow is invoked. */
import { describe, expect, it, vi } from 'vitest';
import { withValidatedInput } from '@axiapay/payments-runtime/shared/validation/input-validation';
import { CreatePaymentQuoteDto } from '../../src/modules/payments/dtos/payment-request.dto.js';
import { InsuredProfileDto } from '../../src/modules/payments/dtos/education-insurance.dto.js';

const quoteIdentity = {
  walletId: '00000000-0000-4000-8000-000000000001',
  productId: '00000000-0000-4000-8000-000000000002',
};

describe('service processor request contracts', () => {
  it('keeps a bill account separate from its delivery contact and preserves merchant identifiers', async () => {
    const consume = vi.fn((input) => input);
    await withValidatedInput(
      CreatePaymentQuoteDto,
      {
        ...quoteIdentity,
        accountValidationId: '00000000-0000-4000-8000-000000000003',
        contactPhoneNumber: '+2348012345678',
      },
      consume,
    );
    expect(consume).toHaveBeenCalledOnce();
    const merchant = await withValidatedInput(
      CreatePaymentQuoteDto,
      {
        ...quoteIdentity,
        merchantRecipientIdentifier: '001-invoice',
        contactPhoneNumber: '+2348012345678',
        amountMinorUnits: '10000',
      },
      (input) => input,
    );
    expect(merchant.merchantRecipientIdentifier).toBe('001-invoice');
  });
  it.each([
    {
      merchantRecipientIdentifier: 'invoice',
      recipientPhoneNumber: '+2348012345678',
    },
    { merchantRecipientIdentifier: '' },
    { merchantRecipientIdentifier: ' invoice' },
    { merchantRecipientIdentifier: 'invoice\nother' },
    {
      merchantRecipientIdentifier: 'invoice',
      contactPhoneNumber: 2348012345678,
    },
    {
      merchantRecipientIdentifier: 'invoice',
      contactPhoneNumber: '08012345678',
    },
    {
      merchantRecipientIdentifier: 'invoice',
      providerKey: 'customer-selected-provider',
    },
  ])(
    'rejects malformed or competing selectors before workflow calls: %j',
    async (fields) => {
      const consume = vi.fn();
      await expect(
        withValidatedInput(
          CreatePaymentQuoteDto,
          { ...quoteIdentity, ...fields },
          consume,
        ),
      ).rejects.toThrow();
      expect(consume).not.toHaveBeenCalled();
    },
  );
  it('accepts typed insurance facts while refusing provider wire fields and implicit phone conversion', async () => {
    const profile = await withValidatedInput(
      InsuredProfileDto,
      {
        fullName: 'Test insured',
        assetReference: '001-PLATE',
        vehicleMake: 'Toyota',
        manufactureYear: '2009',
        nextOfKinPhoneNumber: '+2348012345678',
      },
      (input) => input,
    );
    expect(profile.assetReference).toBe('001-PLATE');
    await expect(
      withValidatedInput(
        InsuredProfileDto,
        { fullName: 'Test insured', vehicle_make: '335' },
        () => undefined,
      ),
    ).rejects.toThrow();
    await expect(
      withValidatedInput(
        InsuredProfileDto,
        { fullName: 'Test insured', nextOfKinPhoneNumber: 2348012345678 },
        () => undefined,
      ),
    ).rejects.toThrow();
  });
  it.each([
    { field: 'vehicleModel' },
    { field: 'state', parentValue: 'Ignored parent' },
    { field: 'vehicleMakeCode' },
    { field: 'localGovernmentArea', parentValue: 123 },
  ])(
    'rejects malformed choice dependencies before discovery: %j',
    async (query) => {
      const list = vi.fn();
      await expect(
        withValidatedInput(InsuranceOptionsQueryDto, query, list),
      ).rejects.toThrow();
      expect(list).not.toHaveBeenCalled();
    },
  );
});
