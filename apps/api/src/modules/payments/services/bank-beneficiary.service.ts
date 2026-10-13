import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ServiceCatalogService } from '../../service-catalog/services/service-catalog.service.js';
import { assertReference } from '../../wallets/domain/money.js';
import { assertBillDisplayText } from '../domain/bill-account.js';
import {
  assertBankAccountNumber,
  assertBankBeneficiaryCurrent,
  type BankBeneficiaryValidation,
} from '../domain/bank-beneficiary.js';
import { PaymentError, assertUuidReference } from '../domain/payment.js';
import type { PaymentRepository } from '../repositories/contracts/payment.repository.js';
import type {
  PaymentClock,
  PaymentProviders,
} from '../ports/service-payment-provider.js';
import { PAYMENTS } from '../payments.tokens.js';

/** Own non-spending bank name enquiry and fresh owner/product/bank-bound recipient evidence; never accept a caller-supplied verified account name. */
@Injectable()
export class BankBeneficiaryService {
  /** Inject authoritative catalogue/storage and an optional non-transfer verification capability. */
  constructor(
    @Inject(PAYMENTS.repository) private readonly payments: PaymentRepository,
    @Inject(ServiceCatalogService)
    private readonly catalogue: ServiceCatalogService,
    @Inject(PAYMENTS.providers) private readonly providers: PaymentProviders,
    @Inject(PAYMENTS.clock) private readonly clock: PaymentClock,
  ) {}

  /** Validate exact numeric identifiers against the published bank profile and persist only fully correlated authenticated names; no funds are held. */
  async verify(input: {
    readonly actorId: string;
    readonly productId: string;
    readonly accountNumber: string;
  }): Promise<BankBeneficiaryValidation> {
    const product = await this.catalogue.getProduct(input.productId);
    if (product.serviceType !== 'bank_transfer' || !product.bankId) {
      throw new PaymentError('INVALID_PAYMENT');
    }
    const bank = await this.catalogue.getBank(product.bankId);
    assertBankAccountNumber(input.accountNumber, bank);
    const verifier = Object.hasOwn(this.providers, product.providerKey)
      ? this.providers[product.providerKey]?.bankBeneficiaryVerification
      : undefined;
    if (!verifier) {
      throw new PaymentError('PAYMENT_UNAVAILABLE');
    }
    const result = await verifier.verify({
      bank,
      product,
      accountNumber: input.accountNumber,
    });
    if (
      result.productId !== product.id ||
      result.bankId !== bank.id ||
      result.accountNumber !== input.accountNumber ||
      result.currency !== bank.currency
    ) {
      throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
    }
    if (result.verificationStatus === 'invalid') {
      throw new PaymentError('BANK_BENEFICIARY_INVALID');
    }
    if (result.verificationStatus !== 'verified') {
      throw new PaymentError('BANK_BENEFICIARY_UNCONFIRMED');
    }
    assertBillDisplayText(result.accountName, 200);
    assertReference(result.evidenceReference);
    const verifiedAt = this.clock.now();
    return this.payments.createBankBeneficiaryValidation({
      id: randomUUID(),
      ownerId: input.actorId,
      productId: product.id,
      bankId: bank.id,
      bankCode: bank.bankCode,
      bankName: bank.displayName,
      countryCode: bank.countryCode,
      currency: bank.currency,
      accountNumber: input.accountNumber,
      accountName: result.accountName,
      evidenceReference: result.evidenceReference,
      verifiedAt,
      expiresAt: new Date(
        verifiedAt.getTime() +
          product.bankBeneficiaryValidationLifetimeSeconds! * 1000,
      ),
    });
  }

  /** Recover only the owner's immutable name-enquiry snapshot; expired or withdrawn-bank evidence remains visible without authorizing fresh spending. */
  async get(
    actorId: string,
    validationId: string,
  ): Promise<BankBeneficiaryValidation> {
    assertUuidReference(validationId);
    const validation = await this.payments.getBankBeneficiaryValidation(
      actorId,
      validationId,
    );
    if (!validation) {
      throw new PaymentError('BANK_BENEFICIARY_NOT_FOUND');
    }
    return validation;
  }

  /** Require fresh evidence for exactly the selected transfer pricing/routing revision; recipient edits require a new enquiry and review. */
  async getCurrent(
    actorId: string,
    validationId: string,
    productId: string,
  ): Promise<BankBeneficiaryValidation> {
    const validation = await this.get(actorId, validationId);
    if (validation.productId !== productId) {
      throw new PaymentError('INVALID_PAYMENT');
    }
    assertBankBeneficiaryCurrent(validation, this.clock.now());
    return validation;
  }
}
