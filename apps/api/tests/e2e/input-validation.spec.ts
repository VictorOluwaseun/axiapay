/** Verify input failures stop at the shared boundary before authentication or payment workflow side effects. */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApplication } from '../../src/bootstrap/create-application.js';
import { withValidatedInput } from '../../src/shared/validation/input-validation.js';
import {
  SignupDto,
  PasswordLoginDto,
  VerifyCodeDto,
  SessionTokenInputDto,
} from '../../src/modules/authentication/dtos/authentication-request.dto.js';
import { AuthenticationService } from '../../src/modules/authentication/services/authentication.service.js';
import {
  EnrollDeviceDto,
  DeviceProofDto,
} from '../../src/modules/authentication/dtos/device-authentication.dto.js';
import { CreateFundingRequestDto } from '../../src/modules/wallet-funding/dtos/funding.dto.js';
import {
  CreatePaymentQuoteDto,
  ProductQueryDto,
} from '../../src/modules/payments/dtos/payment-request.dto.js';
import { CreateInsuranceApplicationDto } from '../../src/modules/payments/dtos/education-insurance.dto.js';
import { CreateBankTransferQuoteDto } from '../../src/modules/payments/dtos/bank-transfer.dto.js';
import { TransferWalletFundsDto } from '../../src/modules/wallets/dtos/wallet-request.dto.js';
import type { AuthenticationResult } from '../../src/modules/authentication/services/authentication-session.js';

const id = 'c764f366-e737-4c84-b63b-0df02ad39c76';
const contact = { kind: 'email', value: 'alice@example.com' };
const session: AuthenticationResult = {
  accessToken: 'A'.repeat(43),
  tokenType: 'Bearer',
  expiresInSeconds: 86400,
  account: {
    id,
    contact: { kind: 'email', value: contact.value },
    verifiedAt: '2030-01-01T00:00:00.000Z',
  },
};
let application: NestFastifyApplication;
beforeAll(async () => {
  application = await createApplication();
  await application.init();
  await application.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await application?.close();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('HTTP input boundary', () => {
  it.each([
    { contact, password: 'a'.repeat(129) },
    {
      contact: { kind: 'phone', value: '08012345678' },
      password: 'valid-length-passphrase',
    },
    {
      contact: { kind: 'email', value: 'alice@localhost' },
      password: 'valid-length-passphrase',
    },
    {
      contact: { kind: 'email', value: 'a..b@example.com' },
      password: 'valid-length-passphrase',
    },
    {
      contact: { kind: 'email', value: 'alice@example.com', admin: true },
      password: 'valid-length-passphrase',
    },
    { contact, password: 123456 },
  ])(
    'rejects invalid login input before entering AuthenticationService (%j)',
    async (payload) => {
      const operation = vi
        .spyOn(application.get(AuthenticationService), 'loginWithPassword')
        .mockImplementation(async () => {
          throw new Error('Invalid input reached the workflow.');
        });
      const response = await application.inject({
        method: 'POST',
        url: '/v1/auth/login/password',
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        code: 'INVALID_INPUT',
        message: 'Invalid request body.',
      });
      expect(operation).not.toHaveBeenCalled();
    },
  );
  it('normalizes contact identity before entering the service while preserving every password character', async () => {
    const operation = vi
      .spyOn(application.get(AuthenticationService), 'loginWithPassword')
      .mockResolvedValue(session);
    const password = '  a private long passphrase  ';
    const response = await application.inject({
      method: 'POST',
      url: '/v1/auth/login/password',
      payload: {
        contact: { kind: 'email', value: ' Alice+Home@Example.COM ' },
        password,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(operation).toHaveBeenCalledWith(
      expect.objectContaining({
        contact: { kind: 'email', value: 'alice+home@example.com' },
        password,
      }),
    );
  });
});

describe('non-HTTP validation wrapper', () => {
  it('validates nested contact input and normalizes it before invoking a job/CLI operation', async () => {
    const operation = vi.fn((input: SignupDto) => ({
      contact: input.contact,
      password: input.password,
    }));
    const result = await withValidatedInput(
      SignupDto,
      {
        contact: { kind: 'email', value: ' Alice+Home@Example.COM ' },
        password: '  a private long passphrase  ',
      },
      operation,
    );
    expect(result).toEqual({
      contact: { kind: 'email', value: 'alice+home@example.com' },
      password: '  a private long passphrase  ',
    });
    expect(operation).toHaveBeenCalledTimes(1);
  });
  it.each([
    'alice',
    'alice@',
    'alice@localhost',
    'a..b@example.com',
    '.alice@example.com',
    'alice\n@example.com',
  ])(
    'rejects invalid email %j without invoking the operation',
    async (value) => {
      const operation = vi.fn();
      await expect(
        withValidatedInput(
          SignupDto,
          { contact: { kind: 'email', value } },
          operation,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(operation).not.toHaveBeenCalled();
    },
  );
  it('normalizes only declared phone strings and never guesses a country or converts identifiers', async () => {
    const result = await withValidatedInput(
      SignupDto,
      { contact: { kind: 'phone', value: ' +2348012345678 ' } },
      (input) => input.contact.value,
    );
    expect(result).toBe('+2348012345678');
    for (const value of ['08012345678', '+123', 2348012345678]) {
      const operation = vi.fn();
      await expect(
        withValidatedInput(
          SignupDto,
          { contact: { kind: 'phone', value } },
          operation,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(operation).not.toHaveBeenCalled();
    }
  });
  it('enforces exact Unicode code-point password bounds without trimming or variation-selector folding', async () => {
    const unicode = '🔐'.repeat(128);
    expect(
      await withValidatedInput(
        SignupDto,
        { contact, password: unicode },
        (input) => input.password,
      ),
    ).toBe(unicode);
    for (const password of [
      'short',
      'a'.repeat(129),
      '🔐'.repeat(129),
      '❤\ufe0f'.repeat(65),
    ]) {
      const operation = vi.fn();
      await expect(
        withValidatedInput(SignupDto, { contact, password }, operation),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(operation).not.toHaveBeenCalled();
    }
    await expect(
      withValidatedInput(
        PasswordLoginDto,
        { contact, password: 'a'.repeat(129) },
        (input) => input,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it.each([
    null,
    [],
    { contact: null },
    { contact: [contact] },
    { contact, password: null },
    { contact, actorId: id },
    { contact: { ...contact, admin: true } },
  ])(
    'rejects invalid/over-posted jobs using the same DTO contract (%j)',
    async (payload) => {
      const operation = vi.fn();
      await expect(
        withValidatedInput(SignupDto, payload, operation),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(operation).not.toHaveBeenCalled();
    },
  );
  it('preserves leading-zero codes and rejects numbers or trailing newlines before invoking verification', async () => {
    expect(
      await withValidatedInput(
        VerifyCodeDto,
        { challengeId: id, code: '012345' },
        (input) => input.code,
      ),
    ).toBe('012345');
    for (const code of [12345, '012345\n']) {
      const operation = vi.fn();
      await expect(
        withValidatedInput(VerifyCodeDto, { challengeId: id, code }, operation),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(operation).not.toHaveBeenCalled();
    }
  });
  it('bounds device labels, UUIDs, encoded signatures, and non-HTTP bearer input at the adapter', async () => {
    const operation = vi.fn();
    await expect(
      withValidatedInput(
        DeviceProofDto,
        { credentialId: 'bad-id', challengeId: id, signature: 'AAAA' },
        operation,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      withValidatedInput(
        DeviceProofDto,
        { credentialId: id, challengeId: id, signature: 'AAAA\n' },
        operation,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    for (const deviceName of [' Phone', 'Phone ', 'Phone\nName']) {
      await expect(
        withValidatedInput(
          EnrollDeviceDto,
          { deviceName, publicKey: 'AAAA' },
          operation,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(
      withValidatedInput(
        SessionTokenInputDto,
        { token: 'A'.repeat(43) + '\n' },
        operation,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(operation).not.toHaveBeenCalled();
  });
  it('normalizes funding email before downstream idempotency fingerprinting', async () => {
    const result = await withValidatedInput(
      CreateFundingRequestDto,
      {
        fundingOptionId: 'checkout',
        currency: 'NGN',
        amountMinorUnits: '1000',
        payerEmail: ' Alice+Home@Example.COM ',
        requestKey: 'funding-1',
      },
      (input) => input.payerEmail,
    );
    expect(result).toBe('alice+home@example.com');
  });
  it('validates catalogue filters before a wrapper converts page size and invokes discovery', async () => {
    const operation = vi.fn();
    for (const limit of ['0', '101', 1]) {
      await expect(
        withValidatedInput(ProductQueryDto, { limit }, operation),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(operation).not.toHaveBeenCalled();
    expect(
      await withValidatedInput(
        ProductQueryDto,
        { limit: '25', currency: 'NGN' },
        (input) => Number(input.limit),
      ),
    ).toBe(25);
  });
  it('requires exactly one well-formed recipient selector before reading product state', async () => {
    const operation = vi.fn();
    for (const selectors of [
      {},
      { recipientPhoneNumber: '+2348012345678', accountValidationId: id },
    ]) {
      await expect(
        withValidatedInput(
          CreatePaymentQuoteDto,
          { walletId: id, productId: id, ...selectors },
          operation,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(operation).not.toHaveBeenCalled();
  });
  it('rejects malformed nested insurance profiles and dates before product-specific eligibility logic', async () => {
    const operation = vi.fn();
    for (const insuredProfile of [
      { fullName: 'Alice', dateOfBirth: '2024-02-30' },
      { fullName: 'Alice', phoneNumber: '08012345678' },
      { fullName: 'Alice', email: 'invalid' },
      { fullName: 'Alice', identityNumber: ' 001' },
      { fullName: 'Alice\nSmith' },
    ]) {
      await expect(
        withValidatedInput(
          CreateInsuranceApplicationDto,
          {
            productId: id,
            insuredProfile,
            termsVersion: 'v1',
            acceptedTerms: true,
            coverageStartsOn: '2030-01-01',
          },
          operation,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(operation).not.toHaveBeenCalled();
    await expect(
      withValidatedInput(
        CreateInsuranceApplicationDto,
        {
          productId: id,
          insuredProfile: { fullName: 'Alice' },
          termsVersion: 'v1',
          acceptedTerms: true,
          coverageStartsOn: '2030-02-30',
        },
        operation,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it('rejects narration controls and padded logical identities at their DTO boundary', async () => {
    const operation = vi.fn();
    await expect(
      withValidatedInput(
        CreateBankTransferQuoteDto,
        {
          walletId: id,
          productId: id,
          bankBeneficiaryValidationId: id,
          amountMinorUnits: '1000',
          narration: 'transfer\nnote',
        },
        operation,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      withValidatedInput(
        TransferWalletFundsDto,
        {
          currency: 'NGN',
          destinationWalletId: id,
          amountMinorUnits: '1000',
          requestKey: 'key\n',
        },
        operation,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(operation).not.toHaveBeenCalled();
  });
});
