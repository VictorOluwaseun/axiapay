/** Verify first-party OpenAPI contracts and adapter-disabled composition through the actual API bootstrap. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApplication } from '../../src/bootstrap/create-application.js';

let application: NestFastifyApplication;
beforeAll(async () => {
  application = await createApplication();
  await application.init();
  await application.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await application?.close();
});

describe('airtime/data public contracts', () => {
  it('documents authentication, exact monetary strings and provider-independent submission/recovery contracts', async () => {
    const response = await application.inject({
      method: 'GET',
      url: '/docs-json',
    });
    const document = response.json();
    for (const [route, method] of [
      ['/v1/service-catalog/products', 'get'],
      ['/v1/service-catalog/products/{productId}', 'get'],
      ['/v1/payments/quotes', 'post'],
      ['/v1/payments/quotes/{quoteId}', 'get'],
      ['/v1/payments', 'post'],
      ['/v1/payments/by-request-key', 'get'],
      ['/v1/payments/{paymentId}', 'get'],
      ['/v1/payments/{paymentId}/reconcile', 'post'],
      ['/v1/payments/account-validations', 'post'],
      ['/v1/payments/account-validations/{validationId}', 'get'],
      ['/v1/payments/education-validations', 'post'],
      ['/v1/payments/education-validations/{preparationId}', 'get'],
      ['/v1/payments/insurance-applications', 'post'],
      ['/v1/payments/insurance-applications/{preparationId}', 'get'],
      ['/v1/payments/{paymentId}/documents/{documentId}', 'get'],
      ['/v1/bank-transfers/banks', 'get'],
      ['/v1/bank-transfers/banks/{bankId}', 'get'],
      ['/v1/bank-transfers/products', 'get'],
      ['/v1/bank-transfers/beneficiary-validations', 'post'],
      ['/v1/bank-transfers/beneficiary-validations/{validationId}', 'get'],
      ['/v1/bank-transfers/quotes', 'post'],
      ['/v1/bank-transfers/quotes/{quoteId}', 'get'],
      ['/v1/bank-transfers', 'post'],
      ['/v1/bank-transfers/by-request-key', 'get'],
      ['/v1/bank-transfers/{transferId}', 'get'],
      ['/v1/bank-transfers/{transferId}/reconcile', 'post'],
    ]) {
      expect(document.paths[route!][method!].security).toEqual([
        { bearer: [] },
      ]);
      expect(document.paths[route!][method!].responses).toHaveProperty('401');
    }
    const insurance = document.components.schemas.CreateInsuranceApplicationDto;
    expect(insurance.required.sort()).toEqual([
      'acceptedTerms',
      'coverageStartsOn',
      'insuredProfile',
      'productId',
      'termsVersion',
    ]);
    expect(insurance.properties.insuredProfile).toEqual({
      $ref: '#/components/schemas/InsuredProfileDto',
    });
    expect(
      document.components.schemas.PaymentDocumentResponseDto.properties,
    ).not.toHaveProperty('providerDocumentReference');
    expect(
      document.paths['/v1/payments/{paymentId}/documents/{documentId}'].get
        .responses['200'].content['application/pdf'].schema.format,
    ).toBe('binary');
    const bankQuote = document.components.schemas.CreateBankTransferQuoteDto;
    expect(bankQuote.required.sort()).toEqual([
      'amountMinorUnits',
      'bankBeneficiaryValidationId',
      'productId',
      'walletId',
    ]);
    expect(Object.keys(bankQuote.properties).sort()).toEqual([
      'amountMinorUnits',
      'bankBeneficiaryValidationId',
      'narration',
      'productId',
      'walletId',
    ]);
    expect(
      document.components.schemas.SubmitBankTransferDto.required.sort(),
    ).toEqual(['quoteId', 'requestKey']);
    expect(
      document.components.schemas.BankTransferResponseDto.properties.fundsStatus
        .enum,
    ).toEqual(['not_reserved', 'reserved', 'debited', 'released']);
    expect(
      document.components.schemas.BankTransferConfirmationResponseDto.properties
        .amountMinorUnits.type,
    ).toBe('string');
    for (const name of [
      'BankResponseDto',
      'BankBeneficiaryValidationResponseDto',
      'BankTransferProductResponseDto',
      'BankTransferResponseDto',
    ]) {
      expect(document.components.schemas[name].properties).not.toHaveProperty(
        'providerKey',
      );
      expect(document.components.schemas[name].properties).not.toHaveProperty(
        'evidenceReference',
      );
      expect(document.components.schemas[name].properties).not.toHaveProperty(
        'partnerAccountId',
      );
    }
    const submission = document.components.schemas.SubmitServicePaymentDto;
    expect(submission.required.sort()).toEqual(['quoteId', 'requestKey']);
    expect(Object.keys(submission.properties).sort()).toEqual([
      'quoteId',
      'requestKey',
    ]);
    expect(
      document.components.schemas.CreatePaymentQuoteDto.properties
        .amountMinorUnits.type,
    ).toBe('string');
    expect(
      document.components.schemas.PaymentQuoteResponseDto.properties
        .totalDebitMinorUnits.type,
    ).toBe('string');
    expect(
      document.components.schemas.PaymentQuoteResponseDto.properties,
    ).not.toHaveProperty('providerKey');
    expect(
      document.components.schemas.ServicePaymentResponseDto.properties,
    ).not.toHaveProperty('partnerAccountId');
    const validation =
      document.components.schemas.CreateBillAccountValidationDto;
    expect(validation.required.sort()).toEqual(['accountNumber', 'productId']);
    expect(validation.properties.accountNumber.type).toBe('string');
    expect(Object.keys(validation.properties).sort()).toEqual([
      'accountNumber',
      'productId',
    ]);
    expect(
      document.components.schemas.CreatePaymentQuoteDto.required,
    ).not.toContain('recipientPhoneNumber');
    expect(
      document.components.schemas.CreatePaymentQuoteDto.properties,
    ).toHaveProperty('accountValidationId');
    expect(
      document.components.schemas.ServiceProductResponseDto.properties
        .serviceType.enum,
    ).toEqual([
      'airtime',
      'data',
      'tv',
      'electricity',
      'education',
      'insurance',
      'bank_transfer',
      'merchant',
    ]);
    expect(
      document.components.schemas.ServicePaymentResponseDto.properties
        .fulfilment.oneOf,
    ).toHaveLength(7);
    expect(
      document.components.schemas.PrepaidElectricityFulfilmentResponseDto
        .properties.unitsKilowattHours.type,
    ).toBe('string');
    expect(
      document.components.schemas.PostpaidElectricityFulfilmentResponseDto
        .properties,
    ).not.toHaveProperty('tokens');
  });
});
