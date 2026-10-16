import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ServiceCatalogService } from '../../service-catalog/services/service-catalog.service.js';
import { assertReference } from '../../wallets/domain/money.js';
import {
  assertInsuranceApplicationCurrent,
  insuranceApplicationFingerprint,
  requestedCoverageEnd,
  validatedInsuredProfile,
  type InsuranceApplication,
  type InsuredProfile,
} from '../domain/insurance-application.js';
import { PaymentError } from '../domain/payment.js';
import type { PaymentRepository } from '../repositories/contracts/payment.repository.js';
import type {
  PaymentClock,
  PaymentProviders,
} from '../ports/service-payment-provider.js';
import { PAYMENTS } from '../payments.tokens.js';

/** Own explicit terms consent and confirmed eligibility for fixed-premium individual products; never infer policy issuance or active coverage. */
@Injectable()
export class InsuranceApplicationService {
  /** Inject authoritative product terms, owner-scoped storage and replaceable non-purchasing eligibility capability. */
  constructor(
    @Inject(PAYMENTS.repository) private readonly payments: PaymentRepository,
    @Inject(ServiceCatalogService)
    private readonly catalogue: ServiceCatalogService,
    @Inject(PAYMENTS.providers) private readonly providers: PaymentProviders,
    @Inject(PAYMENTS.clock) private readonly clock: PaymentClock,
  ) {}

  /** Validate requested fields and reviewed terms, derive the exclusive period end, and persist consent only after correlated eligibility confirmation. */
  async create(input: {
    readonly actorId: string;
    readonly productId: string;
    readonly insuredProfile: InsuredProfile;
    readonly termsVersion: string;
    readonly acceptedTerms: boolean;
    readonly coverageStartsOn: string;
  }): Promise<InsuranceApplication> {
    const product = await this.catalogue.getProduct(input.productId);
    if (product.serviceType !== 'insurance' || !product.insuranceTerms) {
      throw new PaymentError('INVALID_PAYMENT');
    }
    if (input.acceptedTerms !== true) {
      throw new PaymentError('INVALID_PAYMENT');
    }
    if (input.termsVersion !== product.insuranceTerms.version) {
      throw new PaymentError('INSURANCE_TERMS_CHANGED');
    }
    const now = this.clock.now();
    if (input.coverageStartsOn < now.toISOString().slice(0, 10)) {
      throw new PaymentError('INVALID_PAYMENT');
    }
    const profile = validatedInsuredProfile(
      input.insuredProfile,
      product.insuranceTerms,
      now,
    );
    const coverageEndsOn = requestedCoverageEnd(
      input.coverageStartsOn,
      product.insuranceTerms.coverageDurationDays,
    );
    const fingerprint = insuranceApplicationFingerprint(
      product.id,
      profile,
      input.termsVersion,
      input.coverageStartsOn,
      coverageEndsOn,
    );
    const verifier = Object.hasOwn(this.providers, product.providerKey)
      ? this.providers[product.providerKey]?.insuranceEligibility
      : undefined;
    if (!verifier) {
      throw new PaymentError('PAYMENT_UNAVAILABLE');
    }
    const result = await verifier.verify({
      product,
      insuredProfile: profile,
      termsVersion: input.termsVersion,
      coverageStartsOn: input.coverageStartsOn,
      coverageEndsOn,
      applicationFingerprint: fingerprint,
    });
    if (result.applicationFingerprint !== fingerprint) {
      throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
    }
    if (result.eligibilityStatus === 'ineligible') {
      throw new PaymentError('INSURANCE_INELIGIBLE');
    }
    if (result.eligibilityStatus !== 'eligible') {
      throw new PaymentError('INSURANCE_UNCONFIRMED');
    }
    assertReference(result.evidenceReference);
    const createdAt = this.clock.now();
    return this.payments.createInsuranceApplication({
      id: randomUUID(),
      ownerId: input.actorId,
      productId: product.id,
      insuredProfile: profile,
      termsVersion: input.termsVersion,
      acceptedTerms: true,
      coverageStartsOn: input.coverageStartsOn,
      coverageEndsOn,
      evidenceReference: result.evidenceReference,
      createdAt,
      expiresAt: new Date(
        createdAt.getTime() +
          product.insuranceApplicationLifetimeSeconds! * 1000,
      ),
    });
  }

  /** Recover only the owning customer's immutable consent/eligibility record, including its actual expiry. */
  async get(
    actorId: string,
    applicationId: string,
  ): Promise<InsuranceApplication> {
    const application = await this.payments.getInsuranceApplication(
      actorId,
      applicationId,
    );
    if (!application) {
      throw new PaymentError('INSURANCE_APPLICATION_NOT_FOUND');
    }
    return application;
  }

  /** Bind a quote to a fresh owner/product-specific eligible application. */
  async getCurrent(
    actorId: string,
    applicationId: string,
    productId: string,
  ): Promise<InsuranceApplication> {
    const application = await this.get(actorId, applicationId);
    if (application.productId !== productId) {
      throw new PaymentError('INVALID_PAYMENT');
    }
    assertInsuranceApplicationCurrent(application, this.clock.now());
    return application;
  }
}
