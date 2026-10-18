import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PaymentFeaturePolicy } from '../ports/payment-feature-policy.js';
import { ServiceCatalogService } from '../../service-catalog/services/service-catalog.service.js';
import { assertReference } from '../../wallets/domain/money.js';
import { assertBillDisplayText } from '../domain/bill-account.js';
import {
  assertEducationRecipientCurrent,
  type EducationRecipientValidation,
} from '../domain/education-recipient.js';
import { PaymentError } from '../domain/payment.js';
import type { PaymentRepository } from '../repositories/contracts/payment.repository.js';
import type {
  PaymentClock,
  PaymentProviders,
} from '../ports/service-payment-provider.js';
import { PAYMENTS } from '../payments.tokens.js';

/** Own institution/product-bound beneficiary verification; evidence authorizes review, never a payment or voucher purchase. */
@Injectable()
export class EducationRecipientService {
  /** Inject authoritative catalogue/storage and non-purchasing verification capability. */
  constructor(
    @Inject(PAYMENTS.featurePolicy)
    private readonly featurePolicy: PaymentFeaturePolicy,
    @Inject(PAYMENTS.repository) private readonly payments: PaymentRepository,
    @Inject(ServiceCatalogService)
    private readonly catalogue: ServiceCatalogService,
    @Inject(PAYMENTS.providers) private readonly providers: PaymentProviders,
    @Inject(PAYMENTS.clock) private readonly clock: PaymentClock,
  ) {}

  /** Persist only independently verified beneficiaries; preserve exact identifiers and leading zeros without touching funds. */
  async verify(input: {
    readonly actorId: string;
    readonly productId: string;
    readonly beneficiaryIdentifier: string;
  }): Promise<EducationRecipientValidation> {
    const product = await this.catalogue.getProduct(input.productId);
    if (!(await this.featurePolicy.isEnabled(product.serviceType))) {
      throw new PaymentError('FEATURE_DISABLED');
    }
    if (
      product.serviceType !== 'education' ||
      product.educationRecipientVerificationRequired === false
    ) {
      throw new PaymentError('INVALID_PAYMENT');
    }
    const verifier = Object.hasOwn(this.providers, product.providerKey)
      ? this.providers[product.providerKey]?.educationVerification
      : undefined;
    if (!verifier) {
      throw new PaymentError('PAYMENT_UNAVAILABLE');
    }
    const result = await verifier.verify({
      product,
      beneficiaryIdentifier: input.beneficiaryIdentifier,
    });
    if (
      result.productId !== product.id ||
      result.institutionCode !== product.billerCode ||
      result.beneficiaryIdentifier !== input.beneficiaryIdentifier
    ) {
      throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
    }
    if (result.verificationStatus === 'invalid') {
      throw new PaymentError('EDUCATION_BENEFICIARY_INVALID');
    }
    if (result.verificationStatus !== 'verified') {
      throw new PaymentError('EDUCATION_BENEFICIARY_UNCONFIRMED');
    }
    assertBillDisplayText(result.beneficiaryName, 200);
    assertReference(result.evidenceReference);
    const verifiedAt = this.clock.now();
    return this.payments.createEducationValidation({
      id: randomUUID(),
      ownerId: input.actorId,
      productId: product.id,
      institutionCode: product.billerCode!,
      paymentType: product.educationPaymentType!,
      purpose: product.educationPurpose!,
      beneficiaryIdentifier: input.beneficiaryIdentifier,
      beneficiaryName: result.beneficiaryName,
      evidenceReference: result.evidenceReference,
      verifiedAt,
      expiresAt: new Date(
        verifiedAt.getTime() +
          product.educationValidationLifetimeSeconds! * 1000,
      ),
    });
  }

  /** Recover owner-scoped evidence without repeating verification; expired details remain visible for identification. */
  async get(
    actorId: string,
    validationId: string,
  ): Promise<EducationRecipientValidation> {
    const validation = await this.payments.getEducationValidation(
      actorId,
      validationId,
    );
    if (!validation) {
      throw new PaymentError('EDUCATION_VALIDATION_NOT_FOUND');
    }
    return validation;
  }

  /** Require the selected product and fresh evidence before beneficiary details can enter immutable review terms. */
  async getCurrent(
    actorId: string,
    validationId: string,
    productId: string,
  ): Promise<EducationRecipientValidation> {
    const validation = await this.get(actorId, validationId);
    if (validation.productId !== productId) {
      throw new PaymentError('INVALID_PAYMENT');
    }
    assertEducationRecipientCurrent(validation, this.clock.now());
    return validation;
  }
}
