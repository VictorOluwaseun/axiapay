import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PaymentFeaturePolicy } from '../ports/payment-feature-policy.js';
import { ServiceCatalogService } from '../../service-catalog/services/service-catalog.service.js';
import type { ServiceProduct } from '../../service-catalog/domain/service-product.js';
import { assertReference } from '../../wallets/domain/money.js';
import { PaymentError } from '../domain/payment.js';
import {
  assertBillAccountCurrent,
  assertBillDisplayText,
  type BillAccountValidation,
} from '../domain/bill-account.js';
import type { PaymentRepository } from '../repositories/contracts/payment.repository.js';
import type {
  PaymentClock,
  PaymentProviders,
} from '../ports/service-payment-provider.js';
import type { BillAccountVerificationResult } from '../ports/bill-account-verification.js';
import { PAYMENTS } from '../payments.tokens.js';

/** Own non-financial TV/electricity recipient verification, bounded evidence lifetime and owner/product binding; never manufacture a verified account. */
@Injectable()
export class BillAccountService {
  /** Inject first-party storage, catalogue and optional verification ports; concrete provider clients remain at the composition boundary. */
  constructor(
    @Inject(PAYMENTS.featurePolicy)
    private readonly featurePolicy: PaymentFeaturePolicy,
    @Inject(PAYMENTS.repository) private readonly payments: PaymentRepository,
    @Inject(ServiceCatalogService)
    private readonly catalogue: ServiceCatalogService,
    @Inject(PAYMENTS.providers) private readonly providers: PaymentProviders,
    @Inject(PAYMENTS.clock) private readonly clock: PaymentClock,
  ) {}

  /** Validate without spending or submitting; a missing adapter, invalid recipient or unresolved observation creates no verified record. */
  async verify(input: {
    readonly actorId: string;
    readonly productId: string;
    readonly accountNumber: string;
  }): Promise<BillAccountValidation> {
    const product = await this.catalogue.getProduct(input.productId);
    if (!(await this.featurePolicy.isEnabled(product.serviceType))) {
      throw new PaymentError('FEATURE_DISABLED');
    }
    if (!['tv', 'electricity'].includes(product.serviceType)) {
      throw new PaymentError('INVALID_PAYMENT');
    }
    const verifier = Object.hasOwn(this.providers, product.providerKey)
      ? this.providers[product.providerKey]?.accountVerification
      : undefined;
    if (!verifier) {
      throw new PaymentError('PAYMENT_UNAVAILABLE');
    }
    const result = await verifier.verify({
      product,
      accountNumber: input.accountNumber,
    });
    this.assertVerifiedResult(product, input.accountNumber, result);
    const verifiedAt = this.clock.now();
    return this.payments.createAccountValidation({
      id: randomUUID(),
      ownerId: input.actorId,
      productId: product.id,
      serviceType: product.serviceType as BillAccountValidation['serviceType'],
      billerCode: product.billerCode!,
      electricityMeterType: product.electricityMeterType,
      accountNumber: input.accountNumber,
      customerName: result.customerName,
      serviceAddress: result.serviceAddress,
      evidenceReference: result.evidenceReference,
      verifiedAt,
      expiresAt: new Date(
        verifiedAt.getTime() + product.accountValidationLifetimeSeconds! * 1000,
      ),
    });
  }

  /** Read owner-scoped immutable customer details; even expired records remain identifiable without claiming fresh validation. */
  async get(
    actorId: string,
    validationId: string,
  ): Promise<BillAccountValidation> {
    const validation = await this.payments.getAccountValidation(
      actorId,
      validationId,
    );
    if (!validation) {
      throw new PaymentError('ACCOUNT_VALIDATION_NOT_FOUND');
    }
    return validation;
  }

  /** Require fresh validation for the selected product and owner; a different package or meter mode needs its own verified snapshot. */
  async getCurrent(
    actorId: string,
    validationId: string,
    productId: string,
  ): Promise<BillAccountValidation> {
    const validation = await this.get(actorId, validationId);
    if (validation.productId !== productId) {
      throw new PaymentError('INVALID_PAYMENT');
    }
    assertBillAccountCurrent(validation, this.clock.now());
    return validation;
  }

  /** Check exact correlation and readable authenticated evidence before it can enter a quote; pending is not invalid and neither is verified. */
  private assertVerifiedResult(
    product: ServiceProduct,
    accountNumber: string,
    result: BillAccountVerificationResult,
  ): asserts result is Extract<
    BillAccountVerificationResult,
    { verificationStatus: 'verified' }
  > {
    if (
      result.productId !== product.id ||
      result.accountNumber !== accountNumber ||
      result.billerCode !== product.billerCode ||
      result.electricityMeterType !== product.electricityMeterType
    ) {
      throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
    }
    if (result.verificationStatus === 'invalid') {
      throw new PaymentError('ACCOUNT_INVALID');
    }
    if (result.verificationStatus !== 'verified') {
      throw new PaymentError('ACCOUNT_UNCONFIRMED');
    }
    assertBillDisplayText(result.customerName, 200);
    if (result.serviceAddress !== null) {
      assertBillDisplayText(result.serviceAddress, 500);
    }
    assertReference(result.evidenceReference);
  }
}
