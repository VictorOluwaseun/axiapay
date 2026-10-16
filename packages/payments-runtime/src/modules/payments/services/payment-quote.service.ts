import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ServiceCatalogService } from '../../service-catalog/services/service-catalog.service.js';
import {
  assertWalletActive,
  assertWalletOwner,
  type Wallet,
} from '../../wallets/domain/wallet.js';
import { WalletError } from '../../wallets/domain/wallet-error.js';
import {
  assertQuoteCurrent,
  PaymentError,
  quotePrincipal,
  type PaymentQuote,
} from '../domain/payment.js';
import type { PaymentRepository } from '../repositories/contracts/payment.repository.js';
import type {
  PaymentClock,
  PaymentProviders,
} from '../ports/service-payment-provider.js';
import { PAYMENTS } from '../payments.tokens.js';
import {
  hasProductSubmissionCapabilities,
  isSubmissionUnavailable,
} from './payment-provider-capabilities.js';
import { BankBeneficiaryService } from './bank-beneficiary.service.js';
import {
  assertBankBeneficiaryCurrent,
  type BankBeneficiaryValidation,
} from '../domain/bank-beneficiary.js';
import { BillAccountService } from './bill-account.service.js';
import {
  assertBillAccountCurrent,
  type BillAccountValidation,
} from '../domain/bill-account.js';
import { EducationRecipientService } from './education-recipient.service.js';
import { InsuranceApplicationService } from './insurance-application.service.js';
import {
  assertEducationRecipientCurrent,
  type EducationRecipientValidation,
} from '../domain/education-recipient.js';
import {
  assertInsuranceApplicationCurrent,
  type InsuranceApplication,
} from '../domain/insurance-application.js';
import type { ServiceProduct } from '../../service-catalog/domain/service-product.js';

/** Exactly one service-specific recipient preparation; mobile products use an explicit phone instead. */
interface QuoteRecipient {
  readonly accountValidation: BillAccountValidation | null;
  readonly bankBeneficiaryValidation: BankBeneficiaryValidation | null;
  readonly educationValidation: EducationRecipientValidation | null;
  readonly insuranceApplication: InsuranceApplication | null;
}

/** Input recipient selectors are mutually exclusive and never silently ignored. */
interface QuoteRecipientInput {
  readonly recipientPhoneNumber?: string;
  readonly contactPhoneNumber?: string;
  readonly merchantRecipientIdentifier?: string;
  readonly accountValidationId?: string;
  readonly bankBeneficiaryValidationId?: string;
  readonly educationValidationId?: string;
  readonly insuranceApplicationId?: string;
}

/** Own immutable review quotes and server pricing; quotes authorize no wallet movement and preserve a selected network explicitly. */
@Injectable()
export class PaymentQuoteService {
  /** Depend on first-party catalogue and storage contracts, plus replaceable time and adapter availability. */
  constructor(
    @Inject(PAYMENTS.repository) private readonly payments: PaymentRepository,
    @Inject(ServiceCatalogService)
    private readonly catalogue: ServiceCatalogService,
    @Inject(PAYMENTS.clock) private readonly clock: PaymentClock,
    @Inject(PAYMENTS.providers) private readonly providers: PaymentProviders,
    @Inject(BillAccountService)
    private readonly billAccounts: BillAccountService,
    @Inject(EducationRecipientService)
    private readonly education: EducationRecipientService,
    @Inject(InsuranceApplicationService)
    private readonly insurance: InsuranceApplicationService,
    @Inject(BankBeneficiaryService)
    private readonly bankBeneficiaries: BankBeneficiaryService,
  ) {}

  /** Snapshot selected product terms for an authoritatively read wallet. Variable or fixed prices and service-specific beneficiary/consent snapshots follow the selected immutable product. */
  async create(input: {
    readonly actorId: string;
    readonly wallet: Wallet;
    readonly productId: string;
    readonly recipientPhoneNumber?: string;
    readonly contactPhoneNumber?: string;
    readonly merchantRecipientIdentifier?: string;
    readonly accountValidationId?: string;
    readonly narration?: string;
    readonly bankBeneficiaryValidationId?: string;
    readonly educationValidationId?: string;
    readonly insuranceApplicationId?: string;
    readonly amountMinorUnits?: bigint;
  }): Promise<PaymentQuote> {
    assertWalletOwner(input.wallet, input.actorId);
    assertWalletActive(input.wallet);
    const product = await this.catalogue.getProduct(input.productId);
    const recipient = await this.resolveRecipient(
      input.actorId,
      product,
      input,
    );
    if (input.wallet.currency !== product.currency) {
      throw new WalletError('CURRENCY_MISMATCH');
    }
    if (
      product.serviceType !== 'bank_transfer' &&
      input.narration !== undefined
    ) {
      throw new PaymentError('INVALID_PAYMENT');
    }

    if (
      product.serviceType === 'airtime' &&
      input.contactPhoneNumber !== undefined &&
      input.contactPhoneNumber !== input.recipientPhoneNumber
    ) {
      throw new PaymentError('INVALID_PAYMENT');
    }
    const principal = quotePrincipal(product, input.amountMinorUnits);
    const createdAt = this.clock.now();
    if (recipient.bankBeneficiaryValidation) {
      assertBankBeneficiaryCurrent(
        recipient.bankBeneficiaryValidation,
        createdAt,
      );
    }
    if (recipient.accountValidation) {
      assertBillAccountCurrent(recipient.accountValidation, createdAt);
    }
    if (recipient.educationValidation) {
      assertEducationRecipientCurrent(recipient.educationValidation, createdAt);
    }
    if (recipient.insuranceApplication) {
      assertInsuranceApplicationCurrent(
        recipient.insuranceApplication,
        createdAt,
      );
    }
    const quote: PaymentQuote = {
      id: randomUUID(),
      ownerId: input.actorId,
      walletId: input.wallet.id,
      productId: product.id,
      serviceType: product.serviceType,
      networkCode: product.networkCode,
      billerCode: product.billerCode,
      electricityMeterType: product.electricityMeterType,
      ...recipient,
      narration: input.narration ?? null,
      educationPaymentType: product.educationPaymentType,
      educationPurpose: product.educationPurpose,
      insuranceTerms: product.insuranceTerms,
      displayName: product.displayName,
      recipientPhoneNumber: input.recipientPhoneNumber ?? null,
      contactPhoneNumber: input.contactPhoneNumber ?? null,
      merchantRecipientIdentifier: input.merchantRecipientIdentifier ?? null,
      principal,
      feeMinorUnits: product.feeMinorUnits,
      totalDebitMinorUnits: principal.amountMinorUnits + product.feeMinorUnits,
      allowanceLabel: product.allowanceLabel,
      validitySeconds: product.validitySeconds,
      providerKey: product.providerKey,
      providerProductCode: product.providerProductCode,
      createdAt,
      expiresAt: new Date(
        Math.min(
          createdAt.getTime() + product.quoteLifetimeSeconds * 1000,
          recipient.bankBeneficiaryValidation?.expiresAt.getTime() ?? Infinity,
          recipient.accountValidation?.expiresAt.getTime() ?? Infinity,
          recipient.educationValidation?.expiresAt.getTime() ?? Infinity,
          recipient.insuranceApplication?.expiresAt.getTime() ?? Infinity,
        ),
      ),
    };
    const registration = Object.hasOwn(this.providers, quote.providerKey)
      ? this.providers[quote.providerKey]
      : undefined;
    await registration?.adapter.verifyPurchaseTerms?.(quote);
    return this.payments.createQuote(quote);
  }

  /** Return only the owner's quote; expiry remains visible for review and does not silently generate fresh prices. */
  async get(actorId: string, quoteId: string): Promise<PaymentQuote> {
    const quote = await this.payments.getQuote(actorId, quoteId);
    if (!quote) {
      throw new PaymentError('QUOTE_NOT_FOUND');
    }
    return quote;
  }

  /** Recheck expiry synchronously under wallet locks; this performs no repository or provider I/O. */
  assertCurrent(quote: PaymentQuote): void {
    assertQuoteCurrent(quote, this.clock.now());
  }

  /** Report deployment capability separately from catalogue terms; missing adapters must not appear purchasable. */
  async canSubmit(quote: PaymentQuote): Promise<boolean> {
    if (!this.isProviderRegistered(quote.providerKey)) {
      return false;
    }
    try {
      assertQuoteCurrent(quote, this.clock.now());
      const product = await this.catalogue.getProduct(quote.productId);
      const registration = this.providers[quote.providerKey]!;
      registration.adapter.validate?.({
        scope: 'quote',
        terms: quote,
      });
      return hasProductSubmissionCapabilities(
        product.serviceType,
        registration,
        product,
      );
    } catch (error) {
      if (isSubmissionUnavailable(error)) {
        return false;
      }
      throw error;
    }
  }

  /** Report explicit adapter presence without exposing routing keys, account configuration or clients in public responses. */
  isProviderRegistered(providerKey: string): boolean {
    return (
      Object.hasOwn(this.providers, providerKey) &&
      this.providers[providerKey] !== undefined
    );
  }

  /** Catalogue capability includes required recipient/eligibility/document capabilities for the selected service, with no SDK/credential exposure. */
  isProductSubmissionAvailable(product: ServiceProduct): boolean {
    if (!this.isProviderRegistered(product.providerKey)) {
      return false;
    }
    const registration = this.providers[product.providerKey]!;
    try {
      registration.adapter.validate?.({
        scope: 'product',
        terms: product,
      });
      return hasProductSubmissionCapabilities(
        product.serviceType,
        registration,
        product,
      );
    } catch (error) {
      if (isSubmissionUnavailable(error)) {
        return false;
      }
      throw error;
    }
  }

  /** Resolve exactly one service-appropriate preparation, rejecting all cross-service selectors. */
  private async resolveRecipient(
    actorId: string,
    product: ServiceProduct,
    input: QuoteRecipientInput,
  ): Promise<QuoteRecipient> {
    const empty: QuoteRecipient = {
      accountValidation: null,
      bankBeneficiaryValidation: null,
      educationValidation: null,
      insuranceApplication: null,
    };
    if (
      product.serviceType === 'bank_transfer' &&
      input.bankBeneficiaryValidationId !== undefined
    ) {
      return {
        ...empty,
        bankBeneficiaryValidation: await this.bankBeneficiaries.getCurrent(
          actorId,
          input.bankBeneficiaryValidationId,
          product.id,
        ),
      };
    }
    if (
      product.serviceType === 'merchant' &&
      input.merchantRecipientIdentifier !== undefined
    ) {
      return empty;
    }
    if (
      product.serviceType === 'education' &&
      product.educationPaymentType === 'voucher' &&
      product.educationRecipientVerificationRequired === false &&
      input.recipientPhoneNumber !== undefined
    ) {
      return empty;
    }
    if (
      product.serviceType === 'education' &&
      product.educationRecipientVerificationRequired !== false &&
      input.educationValidationId !== undefined
    ) {
      return {
        ...empty,
        educationValidation: await this.education.getCurrent(
          actorId,
          input.educationValidationId,
          product.id,
        ),
      };
    }
    if (
      product.serviceType === 'insurance' &&
      input.insuranceApplicationId !== undefined
    ) {
      return {
        ...empty,
        insuranceApplication: await this.insurance.getCurrent(
          actorId,
          input.insuranceApplicationId,
          product.id,
        ),
      };
    }
    if (
      ['tv', 'electricity'].includes(product.serviceType) &&
      input.accountValidationId !== undefined
    ) {
      return {
        ...empty,
        accountValidation: await this.billAccounts.getCurrent(
          actorId,
          input.accountValidationId,
          product.id,
        ),
      };
    }
    if (
      !['airtime', 'data'].includes(product.serviceType) ||
      input.recipientPhoneNumber === undefined
    ) {
      throw new PaymentError('INVALID_PAYMENT');
    }

    return empty;
  }
}
