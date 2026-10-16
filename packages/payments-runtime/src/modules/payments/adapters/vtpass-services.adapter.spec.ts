import { describe, it, expect, vi } from 'vitest';
import { AxiosHeaders, type AxiosAdapter } from 'axios';
import {
  serviceInstruction,
  serviceProduct,
  serviceProcessorCases,
  vtpassServiceDelivered,
  vtpassServiceSettings,
} from '../../../../tests/support/service-processor-fixture.js';
import { axiosTextResponse } from '../../../../tests/support/axios-response-fixture.js';
import {
  vtpassObject,
  vtpassRequestId,
  parseVtpassJson,
} from './vtpass-airtime.protocol.js';
import { VtpassDataAdapter } from './vtpass-data.adapter.js';
import { VtpassTvSubscriptionAdapter } from './vtpass-tv-subscription.adapter.js';
import { VtpassElectricityAdapter } from './vtpass-electricity.adapter.js';
import { VtpassEducationAdapter } from './vtpass-education.adapter.js';
import { VtpassInsuranceAdapter } from './vtpass-insurance.adapter.js';
import { VtpassMerchantPaymentAdapter } from './vtpass-merchant-payment.adapter.js';
import { ServicePaymentProcessor } from '../processors/service-payment.processor.js';
import { vtpassProductSelection } from './vtpass-purchase.protocol.js';
import { money } from '../../wallets/domain/money.js';

/** Explicit test-only merchant envelope; it does not imply VTpass publishes a universal merchant request schema. */
const merchantDefinitions = {
  'reviewed-merchant': {
    productNames: ['Reviewed merchant fixture'],
    transactionType: 'Other Services',
    requiresVariation: false,
    billerCodes: ['reviewed-merchant'],
  },
};

/** Keep the real transport policy, parsing, processor and mapping; replace only the provider's HTTP response. */
function adapterFixture(serviceType: (typeof serviceProcessorCases)[number]) {
  const payment = serviceInstruction(serviceType);
  const response = vtpassServiceDelivered(payment);
  const transport = vi.fn<AxiosAdapter>(async (config) =>
    axiosTextResponse(JSON.stringify(response), 200, config),
  );
  const constructors = {
    data: VtpassDataAdapter,
    tv: VtpassTvSubscriptionAdapter,
    electricity: VtpassElectricityAdapter,
    education: VtpassEducationAdapter,
    insurance: VtpassInsuranceAdapter,
  };
  const adapter =
    serviceType === 'merchant'
      ? new VtpassMerchantPaymentAdapter(
          vtpassServiceSettings,
          merchantDefinitions,
          transport,
        )
      : new constructors[serviceType](vtpassServiceSettings, transport);
  return {
    payment,
    response,
    transport,
    adapter,
    processor: new ServicePaymentProcessor(serviceType, adapter),
  };
}

describe.each(serviceProcessorCases)('VTpass %s protocol', (serviceType) => {
  it('validates pure routing and makes exactly one correctly mapped purchase', async () => {
    const { payment, transport, adapter, processor } =
      adapterFixture(serviceType);
    adapter.validate({ scope: 'product', terms: serviceProduct(payment) });
    adapter.validate({ scope: 'quote', terms: payment.quote });
    expect(transport).not.toHaveBeenCalled();
    expect(await processor.submit(payment)).toMatchObject({
      outcome: 'succeeded',
      providerTransactionReference: '17415991578739548187285972',
    });
    expect(transport).toHaveBeenCalledTimes(1);
    const request = transport.mock.calls[0]![0];
    const body = parseVtpassJson(request.data as string);
    expect(body).toMatchObject({
      request_id: vtpassRequestId(payment),
      serviceID: vtpassProductSelection(payment.quote.providerProductCode)
        .serviceId,
      phone: '08099999999',
    });
    expect(body.quantity).toBe(serviceType === 'tv' ? '1' : undefined);
    if (serviceType === 'tv') {
      expect(request.data).toContain('"quantity":1');
    }
    expect(request).toMatchObject({
      url: 'https://sandbox.vtpass.com/api/pay',
      method: 'post',
      maxRedirects: 0,
      proxy: false,
    });
    expect(request.headers.get('secret-key')).toBe(
      vtpassServiceSettings.secretKey,
    );
    expect(request.headers.has('public-key')).toBe(false);
  });
  it('recovers the same instruction even after purchase eligibility is withdrawn', async () => {
    const { payment, transport, adapter, processor } =
      adapterFixture(serviceType);
    vi.spyOn(adapter, 'validate').mockImplementation(() => {
      throw new Error('No new purchases');
    });
    expect((await processor.lookup(payment)).outcome).toBe('succeeded');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]![0]).toMatchObject({
      url: 'https://sandbox.vtpass.com/api/requery',
      data: JSON.stringify({ request_id: vtpassRequestId(payment) }),
    });
  });
  it.each([
    ['requestId', 'wrong-reference', 'PROVIDER_REQUEST_MISMATCH'],
    ['unique_element', 'wrong-recipient', 'PROVIDER_RECIPIENT_MISMATCH'],
    ['amount', '99', 'PROVIDER_AMOUNT_MISMATCH'],
    ['unit_price', '99', 'PROVIDER_UNIT_PRICE_MISMATCH'],
    ['product_name', 'Wrong product', 'PROVIDER_PRODUCT_MISMATCH'],
    ['quantity', 2, 'PROVIDER_QUANTITY_MISMATCH'],
    ['type', 'Wrong service', 'PROVIDER_SERVICE_MISMATCH'],
  ] as const)(
    'rejects mismatched %s evidence before a financial result',
    async (field, value, reason) => {
      const { payment, response, processor } = adapterFixture(serviceType);
      if (field === 'requestId') {
        response.requestId = value;
      }
      if (field !== 'requestId') {
        vtpassObject(vtpassObject(response.content).transactions)[field] =
          value;
      }
      await expect(processor.submit(payment)).rejects.toMatchObject({
        code: 'INVALID_PROVIDER_EVIDENCE',
        reason,
      });
    },
  );
  it('retains pending outcomes and requires complete proof of failure or reversal', async () => {
    const { payment, transport, processor } = adapterFixture(serviceType);
    transport.mockResolvedValueOnce(
      axiosTextResponse(JSON.stringify({ code: '016' })),
    );
    expect((await processor.submit(payment)).outcome).toBe('pending');
    const reversed = vtpassServiceDelivered(payment);
    reversed.code = '040';
    const transaction = vtpassObject(
      vtpassObject(reversed.content).transactions,
    );
    reversed.content = {
      transactions: {
        status: 'reversed',
        unique_element: transaction.unique_element,
        unit_price: transaction.unit_price,
        commission: 3.5,
        total_amount: 96.5,
        discount: null,
        amount: transaction.amount,
        transactionId: transaction.transactionId,
        wallet_credit_id: '98765432109876543210987654',
      },
    };
    reversed.amount = '96.50';
    transport.mockResolvedValueOnce(
      axiosTextResponse(JSON.stringify(reversed)),
    );
    expect(await processor.lookup(payment)).toMatchObject({
      outcome: 'failed',
      fundsSafeToRelease: true,
      evidenceReference:
        'vtpass:sandbox:17415991578739548187285972:refund:98765432109876543210987654',
    });
  });
});

describe('service-specific VTpass preparation and receipts', () => {
  it.each([
    'mtn-data:mtn-test-plan:extra',
    'mtn-data:',
    'mtn-data:plan with spaces',
    'mtn-data:mtn-test-plan\n',
  ])(
    'rejects malformed catalogue SKU %j before provider I/O',
    (providerProductCode) => {
      const { payment, processor, transport } = adapterFixture('data');
      expect(() =>
        processor.validate({
          scope: 'quote',
          terms: { ...payment.quote, providerProductCode },
        }),
      ).toThrow(expect.objectContaining({ reason: 'PRODUCT_NOT_SUPPORTED' }));
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it.each(['electricity', 'merchant'] as const)(
    'preserves exact %s purchase amounts and string identifiers on the wire',
    async (serviceType) => {
      const { payment, adapter, transport } = adapterFixture(serviceType);
      const request = adapter.toRequest({
        ...payment,
        quote: {
          ...payment.quote,
          principal: money(9007199254740993n, 'NGN'),
        },
      });
      await adapter.execute(request);
      const body = transport.mock.calls[0]![0].data as string;
      expect(body).toContain('"amount":90071992547409.93');
      expect(body).toContain(
        `"billersCode":${JSON.stringify(request.billersCode)}`,
      );
      expect(body).toContain('"phone":"08099999999"');
    },
  );
  it('uses WAEC registration token arrays independently of result-checker serial/PIN cards', async () => {
    const source = serviceInstruction('education');
    const payment = {
      ...source,
      quote: {
        ...source.quote,
        providerProductCode: 'waec-registration:waec-reg-test',
        billerCode: 'waec',
        contactPhoneNumber: null,
        educationValidation: null,
        recipientPhoneNumber: '+2348012345678',
      },
    };
    const response = vtpassServiceDelivered(payment);
    const transport = vi.fn<AxiosAdapter>(async () =>
      axiosTextResponse(JSON.stringify(response)),
    );
    const processor = new ServicePaymentProcessor(
      'education',
      new VtpassEducationAdapter(vtpassServiceSettings, transport),
    );
    expect(await processor.submit(payment)).toMatchObject({
      outcome: 'succeeded',
      fulfilment: {
        fulfilmentType: 'education_voucher',
        voucherCode: '0012345678901234',
        serialNumber: null,
      },
    });
    response.purchased_code = 'Token: 999999999';
    await expect(processor.lookup(payment)).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_EVIDENCE',
    });
  });
  it('resolves motor option names privately, validates parent groups and makes only one purchase', async () => {
    const source = serviceInstruction('insurance');
    const insuredProfile = {
      fullName: 'Test motor insured',
      phoneNumber: '+2348012345678',
      email: 'insured@example.test',
      assetReference: '001-PLATE',
      engineCapacityBand: '0.1 - 1.59',
      chassisNumber: 'TEST-CHASSIS',
      vehicleMake: 'Toyota',
      vehicleModel: 'Corolla',
      vehicleColour: 'Ash',
      manufactureYear: '2009',
      state: 'Abia',
      localGovernmentArea: 'Aba',
    };
    const terms = {
      ...source.quote.insuranceTerms!,
      requiredInsuredFields: Object.keys(
        insuredProfile,
      ) as (keyof typeof insuredProfile)[],
    };
    const payment = {
      ...source,
      quote: {
        ...source.quote,
        providerProductCode: 'ui-insure:1',
        billerCode: 'ui-insure',
        insuranceTerms: terms,
        insuranceApplication: {
          ...source.quote.insuranceApplication!,
          insuredProfile,
        },
      },
    };
    let mismatch = false;
    const transport = vi.fn<AxiosAdapter>(async (config) => {
      const path = new URL(config.url!).pathname;
      const options: Record<string, Record<string, unknown>[]> = {
        brand: [{ VehicleMakeName: 'Toyota', VehicleMakeCode: 1 }],
        color: [{ ColourName: 'Ash', ColourCode: 20 }],
        'engine-capacity': [{ CapacityName: '0.1 - 1.59', CapacityCode: 1 }],
        state: [{ StateName: 'Abia', StateCode: 1 }],
        'model/1': [
          {
            VehicleModelName: 'Corolla',
            VehicleModelCode: 745,
            VehicleMakeCode: mismatch ? 2 : 1,
          },
        ],
        'lga/1': [{ LGAName: 'Aba', LGACode: 770, StateCode: 1 }],
      };
      if (path.includes('/options/')) {
        return axiosTextResponse(
          JSON.stringify({
            response_description: '000',
            content: options[path.split('/options/')[1]!],
          }),
          200,
          config,
        );
      }
      if (path.endsWith('/service-variations')) {
        return axiosTextResponse(
          '{"response_description":"000","content":{"serviceID":"ui-insure","variations":[{"variation_code":"1","fixedPrice":"Yes","variation_amount":"100.00"}]}}',
          200,
          config,
        );
      }
      const response = vtpassServiceDelivered(payment);
      vtpassObject(vtpassObject(response.content).transactions).product_name =
        'Third Party Motor Insurance - Universal Insurance';
      vtpassObject(vtpassObject(response.content).transactions).unique_element =
        insuredProfile.assetReference;
      return axiosTextResponse(JSON.stringify(response), 200, config);
    });
    const adapter = new VtpassInsuranceAdapter(
      vtpassServiceSettings,
      transport,
    );
    const product = serviceProduct(payment);
    expect(
      await adapter.list({
        product,
        field: 'vehicleModel',
        parentValue: 'Toyota',
      }),
    ).toEqual([{ value: 'Corolla', label: 'Corolla' }]);
    expect(
      await adapter.verify({
        product,
        insuredProfile,
        termsVersion: terms.version,
        coverageStartsOn: '2030-01-01',
        coverageEndsOn: '2031-01-01',
        applicationFingerprint: 'test-complete-profile-fingerprint',
      }),
    ).toMatchObject({
      eligibilityStatus: 'eligible',
      applicationFingerprint: 'test-complete-profile-fingerprint',
    });
    expect(
      transport.mock.calls.every(([config]) => config.method === 'get'),
    ).toBe(true);
    expect(
      await new ServicePaymentProcessor('insurance', adapter).submit(payment),
    ).toMatchObject({ outcome: 'succeeded' });
    const purchases = transport.mock.calls.filter(([config]) =>
      config.url!.endsWith('/api/pay'),
    );
    expect(purchases).toHaveLength(1);
    expect(JSON.parse(purchases[0]![0].data as string)).toMatchObject({
      billersCode: '001-PLATE',
      Plate_Number: '001-PLATE',
      vehicle_make: '1',
      vehicle_model: '745',
      vehicle_color: '20',
      state: '1',
      lga: '770',
      Chasis_Number: 'TEST-CHASSIS',
    });
    mismatch = true;
    await expect(
      adapter.list({ product, field: 'vehicleModel', parentValue: 'Toyota' }),
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_EVIDENCE' });
    expect(
      transport.mock.calls.filter(([config]) =>
        config.url!.endsWith('/api/pay'),
      ),
    ).toHaveLength(1);
  });
  it.each(['variations', 'varations'] as const)(
    'checks documented %s with GET credentials and refuses repricing',
    async (variationField) => {
      const { payment, adapter, transport } = adapterFixture('data');
      const variation = {
        variation_code: 'mtn-test-plan',
        variation_amount: '100.00',
        fixedPrice: 'Yes',
      };
      transport.mockImplementation(async (config) =>
        axiosTextResponse(
          JSON.stringify({
            response_description: '000',
            content: { serviceID: 'mtn-data', [variationField]: [variation] },
          }),
          200,
          config,
        ),
      );
      await adapter.verifyPurchaseTerms(payment.quote);
      expect(transport.mock.calls[0]![0].url).toBe(
        'https://sandbox.vtpass.com/api/service-variations?serviceID=mtn-data',
      );
      expect(transport.mock.calls[0]![0].headers.get('public-key')).toBe(
        'test-public-key',
      );
      expect(transport.mock.calls[0]![0].headers.has('secret-key')).toBe(false);
      variation.variation_amount = '101.00';
      await expect(
        adapter.verifyPurchaseTerms(payment.quote),
      ).rejects.toMatchObject({ code: 'PAYMENT_UNAVAILABLE' });
      expect(
        transport.mock.calls.every(([config]) => config.method === 'get'),
      ).toBe(true);
    },
  );
  it('does not advertise fixed-plan products without GET credentials', () => {
    const payment = serviceInstruction('data');
    const adapter = new VtpassDataAdapter({
      ...vtpassServiceSettings,
      publicKey: undefined,
    });
    expect(() =>
      adapter.validate({ scope: 'product', terms: serviceProduct(payment) }),
    ).toThrow(
      expect.objectContaining({ reason: 'PROVIDER_AUTHENTICATION_FAILED' }),
    );
  });
  it.each(['tv', 'electricity'] as const)(
    'performs non-purchasing %s verification without treating transport success as customer evidence',
    async (serviceType) => {
      const payment = serviceInstruction(serviceType);
      const transport = vi.fn<AxiosAdapter>(async (config) =>
        axiosTextResponse(
          JSON.stringify({
            code: '000',
            content: {
              Customer_Name: 'Verified customer',
              Address: 'Verified street',
              ...(serviceType === 'electricity'
                ? { Meter_Number: '001234567890', Meter_Type: 'PREPAID' }
                : {}),
            },
          }),
          200,
          config,
        ),
      );
      const adapter =
        serviceType === 'tv'
          ? new VtpassTvSubscriptionAdapter(vtpassServiceSettings, transport)
          : new VtpassElectricityAdapter(vtpassServiceSettings, transport);
      expect(
        await adapter.verify({
          product: serviceProduct(payment),
          accountNumber: '001234567890',
        }),
      ).toMatchObject({
        verificationStatus: 'verified',
        accountNumber: '001234567890',
        customerName: 'Verified customer',
      });
      expect(transport.mock.calls[0]![0]).toMatchObject({
        url: 'https://sandbox.vtpass.com/api/merchant-verify',
      });
      transport.mockResolvedValueOnce(axiosTextResponse('{"code":"099"}'));
      expect(
        (
          await adapter.verify({
            product: serviceProduct(payment),
            accountNumber: '001234567890',
          })
        ).verificationStatus,
      ).toBe('pending');
    },
  );
  it('correlates PHED verification using its documented MeterNumber field', async () => {
    const payment = serviceInstruction('electricity');
    const content = {
      Customer_Name: 'Verified customer',
      MeterNumber: '001234567890',
      Meter_Type: 'PREPAID',
    };
    const transport = vi.fn<AxiosAdapter>(async () =>
      axiosTextResponse(JSON.stringify({ code: '000', content })),
    );
    const adapter = new VtpassElectricityAdapter(
      vtpassServiceSettings,
      transport,
    );
    const input = {
      product: {
        ...serviceProduct(payment),
        providerProductCode: 'portharcourt-electric',
        billerCode: 'phed',
      },
      accountNumber: '001234567890',
    };
    expect(await adapter.verify(input)).toMatchObject({
      verificationStatus: 'verified',
      accountNumber: input.accountNumber,
    });
    content.MeterNumber = '009999999999';
    await expect(adapter.verify(input)).rejects.toMatchObject({
      reason: 'PROVIDER_RECIPIENT_MISMATCH',
    });
  });

  it('preserves ordered prepaid key-change/recharge tokens and never invents a postpaid token', async () => {
    const { payment, processor } = adapterFixture('electricity');
    const prepaid = await processor.submit(payment);
    expect(prepaid).toMatchObject({
      outcome: 'succeeded',
      fulfilment: {
        fulfilmentType: 'electricity_prepaid',
        unitsKilowattHours: '79.9',
        tokens: [
          { value: '12345678901234567890' },
          { value: '23456789012345678901' },
          { value: '01234567890123456789' },
        ],
      },
    });
    const postpaid = {
      ...payment,
      quote: {
        ...payment.quote,
        electricityMeterType: 'postpaid' as const,
        accountValidation: {
          ...payment.quote.accountValidation!,
          electricityMeterType: 'postpaid' as const,
        },
      },
    };
    expect(await processor.submit(postpaid)).toMatchObject({
      outcome: 'succeeded',
      fulfilment: {
        fulfilmentType: 'electricity_postpaid',
        receiptReference: '001-receipt',
      },
    });
  });
  it('verifies JAMB profiles, while WAEC vouchers use explicit phone delivery without a fabricated candidate lookup', async () => {
    const { payment, transport } = adapterFixture('education');
    const adapter = new VtpassEducationAdapter(
      vtpassServiceSettings,
      transport,
    );
    transport.mockResolvedValueOnce(
      axiosTextResponse(
        '{"code":"000","content":{"Customer_Name":"Test candidate"}}',
      ),
    );
    expect(
      await adapter.verify({
        product: serviceProduct(payment),
        beneficiaryIdentifier: '0123456789',
      }),
    ).toMatchObject({
      verificationStatus: 'verified',
      beneficiaryIdentifier: '0123456789',
    });
    expect(
      JSON.parse(transport.mock.calls[0]![0].data as string),
    ).toMatchObject({
      serviceID: 'jamb',
      billersCode: '0123456789',
      type: 'utme-no-mock',
    });
    const waec = {
      ...payment,
      quote: {
        ...payment.quote,
        providerProductCode: 'waec:waecdirect',
        billerCode: 'waec',
        educationValidation: null,
        contactPhoneNumber: null,
        recipientPhoneNumber: '+2348012345678',
      },
    };
    adapter.validate({ scope: 'product', terms: serviceProduct(waec) });
    transport.mockResolvedValueOnce(
      axiosTextResponse(JSON.stringify(vtpassServiceDelivered(waec))),
    );
    expect(
      await new ServicePaymentProcessor('education', adapter).submit(waec),
    ).toMatchObject({
      outcome: 'succeeded',
      fulfilment: {
        fulfilmentType: 'education_voucher',
        voucherCode: '0012345678901234',
        serialNumber: 'WRN123',
      },
    });
  });
  it('separates insurance premium success from policy issuance and rejects unreviewed eligibility semantics', async () => {
    const { payment, processor, adapter } = adapterFixture('insurance');
    const result = await processor.submit(payment);
    expect(result).toMatchObject({ outcome: 'succeeded' });
    expect(result).not.toHaveProperty('fulfilment');
    expect(result).not.toHaveProperty('documents');
    expect(() =>
      adapter.validate({
        scope: 'quote',
        terms: {
          ...payment.quote,
          insuranceTerms: {
            ...payment.quote.insuranceTerms!,
            eligibilityMode: 'provider_verified',
          },
        },
      }),
    ).toThrow(expect.objectContaining({ reason: 'PRODUCT_NOT_SUPPORTED' }));
  });
  it('retrieves only allowlisted actual PDF bytes without forwarding VTpass credentials', async () => {
    const payment = serviceInstruction('insurance');
    const bytes = Buffer.from('%PDF-1.7\n\u0080\u00ff');
    const documents = vi.fn<AxiosAdapter>(async (config) => ({
      ...axiosTextResponse('', 200, config),
      data: bytes,
      headers: new AxiosHeaders({ 'content-type': 'application/pdf' }),
    }));
    const adapter = new VtpassInsuranceAdapter(
      vtpassServiceSettings,
      undefined,
      documents,
    );
    const document = {
      documentId: 'certificate',
      documentType: 'certificate' as const,
      displayName: 'Test certificate',
      contentType: 'application/pdf' as const,
      providerDocumentReference:
        'https://3rdparty.universalinsuranceonline.com/PrintCertificate.aspx?Data=TESTCERT',
    };
    expect((await adapter.retrieve({ payment, document })).bytes).toEqual(
      bytes,
    );
    expect(documents.mock.calls[0]![0].headers.has('api-key')).toBe(false);
    await expect(
      adapter.retrieve({
        payment,
        document: {
          ...document,
          providerDocumentReference:
            'https://evil.example/PrintCertificate.aspx?Data=TESTCERT',
        },
      }),
    ).rejects.toMatchObject({ code: 'DOCUMENT_UNAVAILABLE' });
    expect(documents).toHaveBeenCalledTimes(1);
    documents.mockResolvedValueOnce({
      ...axiosTextResponse('<html>Certificate</html>'),
      headers: new AxiosHeaders({ 'content-type': 'text/html' }),
    });
    await expect(adapter.retrieve({ payment, document })).rejects.toMatchObject(
      { code: 'DOCUMENT_UNAVAILABLE' },
    );
  });
  it('keeps unreviewed merchant service IDs disabled without constraining other providers', () => {
    const payment = serviceInstruction('merchant');
    const adapter = new VtpassMerchantPaymentAdapter(vtpassServiceSettings, {});
    expect(() =>
      adapter.validate({ scope: 'quote', terms: payment.quote }),
    ).toThrow(expect.objectContaining({ reason: 'PRODUCT_NOT_SUPPORTED' }));
  });
});
