import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ServiceCatalogService } from '../../service-catalog/services/service-catalog.service.js';
import type {
  PaymentOutcomeVerification,
  VerifiedPaymentOutcome,
} from '../../wallets/ports/wallet-verification.js';
import { assertReference } from '../../wallets/domain/money.js';
import {
  assertUuidReference,
  assertPaymentRequestKey,
  assertQuoteCurrent,
  PaymentError,
  paymentTermsFingerprint,
  type ServicePayment,
} from '../domain/payment.js';
import type { PaymentRepository } from '../repositories/contracts/payment.repository.js';
import type {
  PaymentClock,
  PaymentProviderRegistration,
  PaymentProviders,
  ProviderPaymentResult,
} from '../ports/service-payment-provider.js';
import { PAYMENTS } from '../payments.tokens.js';
import {
  needsPaymentFulfilment,
  validatedPaymentFulfilment,
  validatedBankTransferFulfilment,
} from '../domain/payment-fulfilment.js';
import { hasProductSubmissionCapabilities } from './payment-provider-capabilities.js';
import { bankTransferFailureReason } from '../domain/bank-beneficiary.js';
import { validatedPaymentDocument } from '../domain/payment-document.js';

/** Own accepted instructions, the single external submission boundary and correlated final evidence; ledger posting remains a wallet responsibility. */
@Injectable()
export class PaymentExecutionService implements PaymentOutcomeVerification {
  /** Keep provider clients and SQL behind first-party contracts, with no wallet/module dependency cycle. */
  constructor(
    @Inject(PAYMENTS.repository) private readonly payments: PaymentRepository,
    @Inject(ServiceCatalogService)
    private readonly catalogue: ServiceCatalogService,
    @Inject(PAYMENTS.providers) private readonly providers: PaymentProviders,
    @Inject(PAYMENTS.clock) private readonly clock: PaymentClock,
  ) {}

  /** Bind one quote and logical key to one payment; adapter availability and expiry are checked before any financial hold. */
  async accept(input: {
    readonly actorId: string;
    readonly quoteId: string;
    readonly requestKey: string;
  }): Promise<ServicePayment> {
    assertUuidReference(input.quoteId);
    assertPaymentRequestKey(input.requestKey);
    return this.payments.acceptQuote(
      {
        id: randomUUID(),
        ownerId: input.actorId,
        quoteId: input.quoteId,
        requestKey: input.requestKey,
      },
      (quote, product, bank) => {
        assertQuoteCurrent(quote, this.clock.now());
        if (!product.isEnabled) {
          throw new PaymentError('PRODUCT_UNAVAILABLE');
        }
        if (
          product.serviceType === 'bank_transfer' &&
          (!bank?.isEnabled ||
            bank.id !== product.bankId ||
            bank.currency !== product.currency)
        ) {
          throw new PaymentError('BANK_UNAVAILABLE');
        }
        const registration = this.providerFor(quote.providerKey);
        if (
          !hasProductSubmissionCapabilities(product.serviceType, registration)
        ) {
          throw new PaymentError('PAYMENT_UNAVAILABLE');
        }
        return registration;
      },
    );
  }

  /** Enforce ownership for every observable or customer-triggered state transition. */
  async get(actorId: string, paymentId: string): Promise<ServicePayment> {
    assertUuidReference(paymentId);
    const payment = await this.payments.getPayment(paymentId);
    if (!payment || payment.ownerId !== actorId) {
      throw new PaymentError('PAYMENT_NOT_FOUND');
    }
    return payment;
  }

  /** Recover owner-scoped progress when the original response containing the payment ID was lost; this never initiates a purchase. */
  async findByRequestKey(
    actorId: string,
    requestKey: string,
  ): Promise<ServicePayment> {
    assertPaymentRequestKey(requestKey);
    const payment = await this.payments.findByRequestKey(actorId, requestKey);
    if (!payment) {
      throw new PaymentError('PAYMENT_NOT_FOUND');
    }
    return payment;
  }

  /** Revalidate unreserved instructions; expired unfunded quotes require a fresh review rather than unlimited old pricing. */
  async prepareReservation(payment: ServicePayment): Promise<void> {
    const registration = this.providerForPayment(payment);
    if (payment.reservationId) {
      return;
    }
    assertQuoteCurrent(payment.quote, this.clock.now());
    const product = await this.catalogue.getProduct(payment.quote.productId);
    if (!hasProductSubmissionCapabilities(product.serviceType, registration)) {
      throw new PaymentError('PAYMENT_UNAVAILABLE');
    }
  }

  /** Submit only after a durable hold, claiming once before network I/O. Crashes and transport exceptions never reset or retry this boundary. */
  async dispatch(payment: ServicePayment): Promise<ServicePayment> {
    if (payment.outcome || payment.submissionStartedAt) {
      return payment;
    }
    if (!payment.reservationId || payment.reservationStatus !== 'reserved') {
      throw new PaymentError('INVALID_PAYMENT');
    }
    const provider = this.providerForPayment(payment);
    if (!(await this.payments.claimSubmission(payment.id))) {
      return this.readRequired(payment.id);
    }
    const submitted = await this.readRequired(payment.id);
    try {
      const result = await provider.adapter.submit(submitted);
      await this.recordResult(submitted, result);
    } catch (error) {
      throw new PaymentError('PAYMENT_UNAVAILABLE', { cause: error });
    }
    return this.readRequired(payment.id);
  }

  /** Query an already-submitted identity without buying again; a pre-dispatch crash can safely claim its first submission. */
  async reconcile(payment: ServicePayment): Promise<ServicePayment> {
    if (payment.outcome && !needsPaymentFulfilment(payment)) {
      return payment;
    }
    if (!payment.reservationId) {
      return payment;
    }
    if (!payment.submissionStartedAt) {
      return this.dispatch(payment);
    }
    const provider = this.providerForPayment(payment);
    try {
      const result = await provider.adapter.lookup(payment);
      await this.recordResult(payment, result);
    } catch (error) {
      throw new PaymentError('PAYMENT_UNAVAILABLE', { cause: error });
    }
    return this.readRequired(payment.id);
  }

  /** Supply only previously authenticated, correlated, immutable evidence to wallet settlement; public clients cannot manufacture outcomes. */
  async verifyOutcome(paymentId: string): Promise<VerifiedPaymentOutcome> {
    assertUuidReference(paymentId);
    const payment = await this.readRequired(paymentId);
    const outcome = payment.outcome;
    if (!outcome) {
      return { outcome: 'unknown', paymentReference: payment.id };
    }
    if (outcome.outcome === 'failed') {
      return {
        outcome: 'failed',
        paymentReference: payment.id,
        evidenceReference: outcome.evidenceReference,
        fundsSafeToRelease: true,
      };
    }
    return {
      outcome: 'succeeded',
      paymentReference: payment.id,
      evidenceReference: outcome.evidenceReference,
      partnerAccountId: payment.partnerAccountId,
      feeAccountId: payment.feeAccountId,
      principal: payment.quote.principal,
      feeMinorUnits: payment.quote.feeMinorUnits,
    };
  }

  /** Resolve only explicitly registered provider keys, including protection against inherited object properties. */
  private providerFor(providerKey: string): PaymentProviderRegistration {
    const provider = Object.hasOwn(this.providers, providerKey)
      ? this.providers[providerKey]
      : undefined;
    if (!provider) {
      throw new PaymentError('PAYMENT_UNAVAILABLE');
    }
    assertUuidReference(provider.partnerAccountId);
    if (provider.feeAccountId !== null) {
      assertUuidReference(provider.feeAccountId);
    }
    return provider;
  }

  /** An accepted payment retains its clearing accounts; deployment changes require a new routing key instead of reinterpreting old obligations. */
  private providerForPayment(
    payment: ServicePayment,
  ): PaymentProviderRegistration {
    const provider = this.providerFor(payment.quote.providerKey);
    if (
      provider.partnerAccountId !== payment.partnerAccountId ||
      provider.feeAccountId !== payment.feeAccountId
    ) {
      throw new PaymentError('PAYMENT_UNAVAILABLE');
    }
    return provider;
  }

  /** Validate first-party correlation before persisting a safe final result; pending and unsafe failures leave the hold intact. */
  private async recordResult(
    payment: ServicePayment,
    result: ProviderPaymentResult,
  ): Promise<void> {
    if (
      result.paymentId !== payment.id ||
      result.termsFingerprint !== paymentTermsFingerprint(payment)
    ) {
      throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
    }
    if (result.outcome === 'pending') {
      return;
    }
    if (result.outcome === 'failed' && result.fundsSafeToRelease !== true) {
      return;
    }
    if (result.outcome !== 'succeeded' && result.outcome !== 'failed') {
      throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
    }
    assertReference(result.providerTransactionReference);
    assertReference(result.evidenceReference);
    if (
      payment.quote.serviceType === 'bank_transfer' &&
      result.outcome === 'succeeded'
    ) {
      const confirmation = validatedBankTransferFulfilment(
        payment.quote,
        result.fulfilment,
      );
      await this.payments.recordBankTransferSuccess(
        payment.id,
        {
          outcome: 'succeeded',
          providerTransactionReference: result.providerTransactionReference,
          evidenceReference: result.evidenceReference,
        },
        confirmation,
      );
      return;
    }
    await this.payments.recordOutcome(payment.id, {
      outcome: result.outcome,
      providerTransactionReference: result.providerTransactionReference,
      evidenceReference: result.evidenceReference,
      ...(payment.quote.serviceType === 'bank_transfer' &&
      result.outcome === 'failed'
        ? {
            failureReason: bankTransferFailureReason(
              result.bankTransferFailureReason,
            ),
          }
        : {}),
    });
    if (result.outcome === 'succeeded' && result.fulfilment !== undefined) {
      await this.payments.recordFulfilment(
        payment.id,
        validatedPaymentFulfilment(payment.quote, result.fulfilment),
      );
    }
    if (result.outcome !== 'succeeded' || result.documents === undefined) {
      return;
    }
    if (
      !Array.isArray(result.documents) ||
      result.documents.length > 10 ||
      new Set(result.documents.map((document) => document.documentId)).size !==
        result.documents.length
    ) {
      throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
    }
    const current = await this.readRequired(payment.id);
    await this.payments.recordDocuments(
      payment.id,
      result.documents.map((document) =>
        validatedPaymentDocument(current, document),
      ),
    );
  }

  /** Treat missing durable progress as an error, never as permission to create another payment. */
  private async readRequired(paymentId: string): Promise<ServicePayment> {
    const payment = await this.payments.getPayment(paymentId);
    if (!payment) {
      throw new PaymentError('PAYMENT_NOT_FOUND');
    }
    return payment;
  }
}
