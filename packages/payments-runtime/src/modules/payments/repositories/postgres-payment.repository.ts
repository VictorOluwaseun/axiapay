import { sql, type Kysely } from 'kysely';
import { isDeepStrictEqual } from 'node:util';
import type { BillAccountValidation } from '../domain/bill-account.js';
import type { PaymentFulfilment } from '../domain/payment-fulfilment.js';
import type { EducationRecipientValidation } from '../domain/education-recipient.js';
import type {
  InsuranceApplication,
  InsuredProfile,
} from '../domain/insurance-application.js';
import type { PaymentDocument } from '../domain/payment-document.js';
import type { InsuranceProductTerms } from '../../service-catalog/domain/insurance-product-terms.js';
import type { DatabaseSchema } from '../../../infrastructure/database/create-database.js';
import type { PaymentRepository } from './contracts/payment.repository.js';
import {
  PaymentError,
  type PaymentOutcome,
  type PaymentQuote,
  type ServicePayment,
} from '../domain/payment.js';
import {
  bankFromRecord,
  productFromRecord,
} from '../../../infrastructure/database/mappers/service-catalog-record.mapper.js';

import type { BankBeneficiaryValidation } from '../domain/bank-beneficiary.js';

/** PostgreSQL payment storage, using the shared pool and explicit acceptance transactions; all financial reads bypass cache. */
export class PostgresPaymentRepository implements PaymentRepository {
  /** Borrow a lifecycle-managed pool or a transaction-bound connection; never allocate per operation. */
  constructor(private readonly database: Kysely<DatabaseSchema>) {}

  /** @inheritdoc PaymentRepository.createBankBeneficiaryValidation */
  async createBankBeneficiaryValidation(
    validation: BankBeneficiaryValidation,
  ): Promise<BankBeneficiaryValidation> {
    await this.database
      .insertInto('bank_transfer_beneficiary_validations')
      .values({
        id: validation.id,
        owner_id: validation.ownerId,
        product_id: validation.productId,
        bank_id: validation.bankId,
        account_number: validation.accountNumber,
        account_name: validation.accountName,
        evidence_reference: validation.evidenceReference,
        verified_at: validation.verifiedAt,
        expires_at: validation.expiresAt,
      })
      .execute();
    return validation;
  }

  /** @inheritdoc PaymentRepository.getBankBeneficiaryValidation */
  async getBankBeneficiaryValidation(
    ownerId: string,
    validationId: string,
  ): Promise<BankBeneficiaryValidation | null> {
    const record = await this.database
      .selectFrom('bank_transfer_beneficiary_validations as beneficiary')
      .innerJoin(
        'bank_transfer_banks as bank',
        'bank.id',
        'beneficiary.bank_id',
      )
      .selectAll('beneficiary')
      .select([
        'bank.bank_code',
        'bank.display_name as bank_name',
        'bank.country_code',
        'bank.currency',
      ])
      .where('beneficiary.id', '=', validationId)
      .where('beneficiary.owner_id', '=', ownerId)
      .executeTakeFirst();
    if (!record) {
      return null;
    }
    return {
      id: record.id,
      ownerId: record.owner_id,
      productId: record.product_id,
      bankId: record.bank_id,
      bankCode: record.bank_code,
      bankName: record.bank_name,
      countryCode: record.country_code,
      currency: record.currency,
      accountNumber: record.account_number,
      accountName: record.account_name,
      evidenceReference: record.evidence_reference,
      verifiedAt: record.verified_at,
      expiresAt: record.expires_at,
    };
  }

  /** @inheritdoc PaymentRepository.recordBankTransferSuccess */
  async recordBankTransferSuccess(
    paymentId: string,
    outcome: PaymentOutcome,
    confirmation: Extract<
      PaymentFulfilment,
      { fulfilmentType: 'bank_transfer' }
    >,
  ): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      const bound = new PostgresPaymentRepository(transaction);
      await bound.recordOutcome(paymentId, outcome);
      await bound.recordFulfilment(paymentId, confirmation);
    });
  }

  /** @inheritdoc PaymentRepository.createEducationValidation */
  async createEducationValidation(
    validation: EducationRecipientValidation,
  ): Promise<EducationRecipientValidation> {
    await this.database
      .insertInto('service_education_validations')
      .values({
        id: validation.id,
        owner_id: validation.ownerId,
        product_id: validation.productId,
        beneficiary_identifier: validation.beneficiaryIdentifier,
        beneficiary_name: validation.beneficiaryName,
        evidence_reference: validation.evidenceReference,
        verified_at: validation.verifiedAt,
        expires_at: validation.expiresAt,
      })
      .execute();
    return validation;
  }

  /** @inheritdoc PaymentRepository.getEducationValidation */
  async getEducationValidation(
    ownerId: string,
    validationId: string,
  ): Promise<EducationRecipientValidation | null> {
    const record = await this.database
      .selectFrom('service_education_validations as education')
      .innerJoin(
        'service_catalog_products as product',
        'product.id',
        'education.product_id',
      )
      .selectAll('education')
      .select([
        'product.biller_code',
        'product.education_payment_type',
        'product.education_purpose',
      ])
      .where('education.id', '=', validationId)
      .where('education.owner_id', '=', ownerId)
      .executeTakeFirst();
    if (!record) {
      return null;
    }
    return {
      id: record.id,
      ownerId: record.owner_id,
      productId: record.product_id,
      institutionCode: record.biller_code!,
      paymentType:
        record.education_payment_type as EducationRecipientValidation['paymentType'],
      purpose: record.education_purpose!,
      beneficiaryIdentifier: record.beneficiary_identifier,
      beneficiaryName: record.beneficiary_name,
      evidenceReference: record.evidence_reference,
      verifiedAt: record.verified_at,
      expiresAt: record.expires_at,
    };
  }

  /** @inheritdoc PaymentRepository.createInsuranceApplication */
  async createInsuranceApplication(
    application: InsuranceApplication,
  ): Promise<InsuranceApplication> {
    await this.database
      .insertInto('service_insurance_applications')
      .values({
        id: application.id,
        owner_id: application.ownerId,
        product_id: application.productId,
        insured_profile: sql`${JSON.stringify(application.insuredProfile)}::jsonb`,
        terms_version: application.termsVersion,
        accepted_terms: true,
        coverage_starts_on: application.coverageStartsOn,
        coverage_ends_on: application.coverageEndsOn,
        evidence_reference: application.evidenceReference,
        created_at: application.createdAt,
        expires_at: application.expiresAt,
      })
      .execute();
    return application;
  }

  /** @inheritdoc PaymentRepository.getInsuranceApplication */
  async getInsuranceApplication(
    ownerId: string,
    applicationId: string,
  ): Promise<InsuranceApplication | null> {
    const record = await this.database
      .selectFrom('service_insurance_applications as application')
      .innerJoin(
        'service_catalog_products as product',
        'product.id',
        'application.product_id',
      )
      .selectAll('application')
      .select('product.insurance_terms')
      .where('application.id', '=', applicationId)
      .where('application.owner_id', '=', ownerId)
      .executeTakeFirst();
    return record
      ? insuranceFromRecord(
          record,
          record.insurance_terms as unknown as InsuranceProductTerms,
        )
      : null;
  }

  /** @inheritdoc PaymentRepository.createAccountValidation */
  async createAccountValidation(
    validation: BillAccountValidation,
  ): Promise<BillAccountValidation> {
    await this.database
      .insertInto('service_bill_account_validations')
      .values({
        id: validation.id,
        owner_id: validation.ownerId,
        product_id: validation.productId,
        account_number: validation.accountNumber,
        customer_name: validation.customerName,
        service_address: validation.serviceAddress,
        evidence_reference: validation.evidenceReference,
        verified_at: validation.verifiedAt,
        expires_at: validation.expiresAt,
      })
      .execute();
    return validation;
  }

  /** @inheritdoc PaymentRepository.getAccountValidation */
  async getAccountValidation(
    ownerId: string,
    validationId: string,
  ): Promise<BillAccountValidation | null> {
    const record = await this.database
      .selectFrom('service_bill_account_validations as validation')
      .innerJoin(
        'service_catalog_products as product',
        'product.id',
        'validation.product_id',
      )
      .selectAll('validation')
      .select([
        'product.service_type',
        'product.biller_code',
        'product.electricity_meter_type',
      ])
      .where('validation.id', '=', validationId)
      .where('validation.owner_id', '=', ownerId)
      .executeTakeFirst();
    if (!record) {
      return null;
    }
    return {
      id: record.id,
      ownerId: record.owner_id,
      productId: record.product_id,
      serviceType: record.service_type as BillAccountValidation['serviceType'],
      billerCode: record.biller_code!,
      electricityMeterType:
        record.electricity_meter_type as BillAccountValidation['electricityMeterType'],
      accountNumber: record.account_number,
      customerName: record.customer_name,
      serviceAddress: record.service_address,
      evidenceReference: record.evidence_reference,
      verifiedAt: record.verified_at,
      expiresAt: record.expires_at,
    };
  }

  /** @inheritdoc PaymentRepository.createQuote */
  async createQuote(quote: PaymentQuote): Promise<PaymentQuote> {
    await this.database
      .insertInto('service_payment_quotes')
      .values({
        id: quote.id,
        owner_id: quote.ownerId,
        wallet_id: quote.walletId,
        product_id: quote.productId,
        recipient_phone_number: quote.recipientPhoneNumber,
        contact_phone_number: quote.contactPhoneNumber ?? null,
        merchant_recipient_identifier:
          quote.merchantRecipientIdentifier ?? null,
        account_validation_id: quote.accountValidation?.id ?? null,
        bank_beneficiary_validation_id:
          quote.bankBeneficiaryValidation?.id ?? null,
        narration: quote.narration,
        education_validation_id: quote.educationValidation?.id ?? null,
        insurance_application_id: quote.insuranceApplication?.id ?? null,
        currency: quote.principal.currency,
        principal_minor_units: quote.principal.amountMinorUnits,
        fee_minor_units: quote.feeMinorUnits,
        total_debit_minor_units: quote.totalDebitMinorUnits,
        created_at: quote.createdAt,
        expires_at: quote.expiresAt,
      })
      .execute();
    return quote;
  }

  /** Reconstruct review terms from immutable amounts, the selected product revision and any verified bill-recipient snapshot. */
  private quoteSelection() {
    return this.database
      .selectFrom('service_payment_quotes as quote')
      .innerJoin(
        'service_catalog_products as product',
        'product.id',
        'quote.product_id',
      )
      .leftJoin(
        'service_bill_account_validations as validation',
        'validation.id',
        'quote.account_validation_id',
      )
      .leftJoin(
        'service_education_validations as education',
        'education.id',
        'quote.education_validation_id',
      )
      .leftJoin(
        'service_insurance_applications as insurance',
        'insurance.id',
        'quote.insurance_application_id',
      )
      .leftJoin(
        'bank_transfer_beneficiary_validations as beneficiary',
        'beneficiary.id',
        'quote.bank_beneficiary_validation_id',
      )
      .leftJoin('bank_transfer_banks as bank', 'bank.id', 'beneficiary.bank_id')
      .selectAll('quote')
      .select([
        'beneficiary.bank_id as beneficiary_bank_id',
        'beneficiary.account_number as beneficiary_account_number',
        'beneficiary.account_name',
        'beneficiary.evidence_reference as bank_evidence',
        'beneficiary.verified_at as bank_verified_at',
        'beneficiary.expires_at as bank_expires_at',
        'bank.bank_code',
        'bank.display_name as bank_name',
        'bank.country_code',
        'bank.currency as bank_currency',
        'product.service_type',
        'product.network_code',
        'product.display_name',
        'product.allowance_label',
        'product.validity_seconds',
        'product.provider_key',
        'product.provider_product_code',
        'product.biller_code',
        'product.electricity_meter_type',
        'product.education_payment_type',
        'product.education_purpose',
        'product.insurance_terms',
        'education.beneficiary_identifier',
        'education.beneficiary_name',
        'education.evidence_reference as education_evidence',
        'education.verified_at as education_verified_at',
        'education.expires_at as education_expires_at',
        'insurance.insured_profile',
        'insurance.terms_version',
        'insurance.coverage_starts_on',
        'insurance.coverage_ends_on',
        'insurance.evidence_reference as insurance_evidence',
        'insurance.created_at as insurance_created_at',
        'insurance.expires_at as insurance_expires_at',
        'validation.account_number',
        'validation.customer_name',
        'validation.service_address',
        'validation.evidence_reference as validation_evidence_reference',
        'validation.verified_at',
        'validation.expires_at as validation_expires_at',
      ]);
  }

  /** @inheritdoc PaymentRepository.getQuote */
  async getQuote(
    ownerId: string,
    quoteId: string,
  ): Promise<PaymentQuote | null> {
    const record = await this.quoteSelection()
      .where('quote.id', '=', quoteId)
      .where('quote.owner_id', '=', ownerId)
      .executeTakeFirst();
    return record ? quoteFromRecord(record) : null;
  }

  /** @inheritdoc PaymentRepository.findByRequestKey */
  async findByRequestKey(
    ownerId: string,
    requestKey: string,
  ): Promise<ServicePayment | null> {
    const record = await this.database
      .selectFrom('service_payments')
      .select('id')
      .where('owner_id', '=', ownerId)
      .where('request_key', '=', requestKey)
      .executeTakeFirst();
    return record ? this.getPayment(record.id) : null;
  }

  /** @inheritdoc PaymentRepository.getPayment */
  async getPayment(paymentId: string): Promise<ServicePayment | null> {
    const record = await this.quoteSelection()
      .innerJoin('service_payments as payment', 'payment.quote_id', 'quote.id')
      .leftJoin('wallet_reservations as reservation', (join) =>
        join
          .on(
            'reservation.payment_reference',
            '=',
            sql<string>`payment.id::text`,
          )
          .onRef('reservation.wallet_id', '=', 'quote.wallet_id')
          .onRef('reservation.currency', '=', 'quote.currency')
          .onRef(
            'reservation.amount_minor_units',
            '=',
            'quote.total_debit_minor_units',
          ),
      )
      .leftJoin(
        'service_payment_outcomes as result',
        'result.payment_id',
        'payment.id',
      )
      .leftJoin(
        'service_payment_fulfilments as fulfilment',
        'fulfilment.payment_id',
        'payment.id',
      )
      .select([
        'payment.id as payment_id',
        'payment.request_key',
        'payment.partner_account_id',
        'payment.fee_account_id',
        'payment.created_at as payment_created_at',
        'payment.submission_started_at',
        'reservation.id as reservation_id',
        'reservation.reservation_status',
        'result.outcome',
        'result.provider_transaction_reference',
        'result.evidence_reference',
        'result.failure_reason',
        'fulfilment.fulfilment',
      ])
      .select(
        sql<
          readonly PaymentDocument[]
        >`coalesce((select jsonb_agg(jsonb_build_object(
        'documentId', document.document_id, 'documentType', document.document_type, 'displayName', document.display_name,
        'contentType', document.content_type, 'providerDocumentReference', document.provider_document_reference) order by document.document_id)
        from service_payment_documents document where document.payment_id = payment.id), '[]'::jsonb)`.as(
          'documents',
        ),
      )
      .where('payment.id', '=', paymentId)
      .executeTakeFirst();
    if (!record) {
      return null;
    }
    return {
      id: record.payment_id,
      ownerId: record.owner_id,
      requestKey: record.request_key,
      partnerAccountId: record.partner_account_id,
      feeAccountId: record.fee_account_id,
      quote: quoteFromRecord(record),
      createdAt: record.payment_created_at,
      submissionStartedAt: record.submission_started_at,
      reservationId: record.reservation_id,
      reservationStatus:
        record.reservation_status as ServicePayment['reservationStatus'],
      outcome: record.outcome
        ? {
            outcome: record.outcome as PaymentOutcome['outcome'],
            providerTransactionReference:
              record.provider_transaction_reference!,
            evidenceReference: record.evidence_reference!,
            ...(record.failure_reason === null
              ? {}
              : {
                  failureReason: record.failure_reason as NonNullable<
                    PaymentOutcome['failureReason']
                  >,
                }),
          }
        : null,
      fulfilment: record.fulfilment as PaymentFulfilment | null,
      documents: record.documents,
    };
  }

  /** @inheritdoc PaymentRepository.acceptQuote */
  async acceptQuote(
    input: Parameters<PaymentRepository['acceptQuote']>[0],
    validate: Parameters<PaymentRepository['acceptQuote']>[1],
  ): Promise<ServicePayment> {
    return this.database.transaction().execute(async (transaction) => {
      const bound = new PostgresPaymentRepository(transaction);
      const quoteRecord = await transaction
        .selectFrom('service_payment_quotes')
        .select('product_id')
        .where('id', '=', input.quoteId)
        .where('owner_id', '=', input.ownerId)
        .forUpdate()
        .executeTakeFirst();
      if (!quoteRecord) {
        throw new PaymentError('QUOTE_NOT_FOUND');
      }
      const existing = await bound.findByRequestKey(
        input.ownerId,
        input.requestKey,
      );
      if (existing && existing.quote.id !== input.quoteId) {
        throw new PaymentError('PAYMENT_CONFLICT');
      }
      if (existing) {
        return existing;
      }
      const quoteBinding = await transaction
        .selectFrom('service_payments')
        .select('id')
        .where('quote_id', '=', input.quoteId)
        .executeTakeFirst();
      if (quoteBinding) {
        throw new PaymentError('PAYMENT_CONFLICT');
      }
      const productRecord = await transaction
        .selectFrom('service_catalog_products')
        .selectAll()
        .where('id', '=', quoteRecord.product_id)
        .forShare()
        .executeTakeFirstOrThrow();
      const quote = await bound.getQuote(input.ownerId, input.quoteId);
      if (!quote) {
        throw new PaymentError('QUOTE_NOT_FOUND');
      }
      const bankRecord =
        productRecord.bank_id === null
          ? null
          : await transaction
              .selectFrom('bank_transfer_banks')
              .selectAll()
              .where('id', '=', productRecord.bank_id)
              .forShare()
              .executeTakeFirstOrThrow();
      const accounts = validate(
        quote,
        productFromRecord(productRecord),
        bankRecord ? bankFromRecord(bankRecord) : null,
      );
      await transaction
        .insertInto('service_payments')
        .values({
          id: input.id,
          owner_id: input.ownerId,
          quote_id: input.quoteId,
          request_key: input.requestKey,
          partner_account_id: accounts.partnerAccountId,
          fee_account_id: accounts.feeAccountId,
        })
        .onConflict((conflict) => conflict.doNothing())
        .execute();
      const saved = await bound.findByRequestKey(
        input.ownerId,
        input.requestKey,
      );
      if (!saved || saved.quote.id !== input.quoteId) {
        throw new PaymentError('PAYMENT_CONFLICT');
      }
      return saved;
    });
  }

  /** @inheritdoc PaymentRepository.claimSubmission */
  async claimSubmission(paymentId: string): Promise<boolean> {
    const record = await this.database
      .updateTable('service_payments')
      .set({ submission_started_at: sql<Date>`now()` })
      .where('id', '=', paymentId)
      .where('submission_started_at', 'is', null)
      .returning('id')
      .executeTakeFirst();
    return record !== undefined;
  }

  /** @inheritdoc PaymentRepository.recordOutcome */
  async recordOutcome(
    paymentId: string,
    outcome: PaymentOutcome,
  ): Promise<void> {
    const payment = await this.getPayment(paymentId);
    if (!payment) {
      throw new PaymentError('PAYMENT_NOT_FOUND');
    }
    await this.database
      .insertInto('service_payment_outcomes')
      .values({
        payment_id: paymentId,
        provider_key: payment.quote.providerKey,
        outcome: outcome.outcome,
        provider_transaction_reference: outcome.providerTransactionReference,
        evidence_reference: outcome.evidenceReference,
        failure_reason: outcome.failureReason ?? null,
      })
      .onConflict((conflict) => conflict.doNothing())
      .execute();
    const saved = await this.database
      .selectFrom('service_payment_outcomes')
      .selectAll()
      .where('payment_id', '=', paymentId)
      .executeTakeFirst();
    if (
      !saved ||
      saved.outcome !== outcome.outcome ||
      saved.provider_transaction_reference !==
        outcome.providerTransactionReference ||
      saved.failure_reason !== (outcome.failureReason ?? null)
    ) {
      throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
    }
    // Distinct authenticated notifications may carry different evidence references for the same economic movement.
  }

  /** @inheritdoc PaymentRepository.recordFulfilment */
  async recordFulfilment(
    paymentId: string,
    fulfilment: PaymentFulfilment,
  ): Promise<void> {
    await this.database
      .insertInto('service_payment_fulfilments')
      .values({
        payment_id: paymentId,
        fulfilment: sql`${JSON.stringify(fulfilment)}::jsonb`,
      })
      .onConflict((conflict) => conflict.column('payment_id').doNothing())
      .execute();
    const saved = await this.database
      .selectFrom('service_payment_fulfilments')
      .select('fulfilment')
      .where('payment_id', '=', paymentId)
      .executeTakeFirstOrThrow();
    if (!isDeepStrictEqual(saved.fulfilment, fulfilment)) {
      throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
    }
  }

  /** @inheritdoc PaymentRepository.recordDocuments */
  async recordDocuments(
    paymentId: string,
    documents: readonly PaymentDocument[],
  ): Promise<void> {
    if (documents.length === 0) {
      return;
    }
    await this.database.transaction().execute(async (transaction) => {
      for (const document of documents) {
        await transaction
          .insertInto('service_payment_documents')
          .values({
            payment_id: paymentId,
            document_id: document.documentId,
            document_type: document.documentType,
            display_name: document.displayName,
            content_type: document.contentType,
            provider_document_reference: document.providerDocumentReference,
          })
          .onConflict((conflict) =>
            conflict.columns(['payment_id', 'document_id']).doNothing(),
          )
          .execute();
        const saved = await transaction
          .selectFrom('service_payment_documents')
          .selectAll()
          .where('payment_id', '=', paymentId)
          .where('document_id', '=', document.documentId)
          .executeTakeFirstOrThrow();
        if (
          saved.document_type !== document.documentType ||
          saved.display_name !== document.displayName ||
          saved.content_type !== document.contentType ||
          saved.provider_document_reference !==
            document.providerDocumentReference
        ) {
          throw new PaymentError('INVALID_PROVIDER_EVIDENCE');
        }
      }
    });
  }
}

/** Concrete joined quote shape; persistence names never cross the repository interface. */
type QuoteRecord = NonNullable<
  Awaited<
    ReturnType<
      ReturnType<
        PostgresPaymentRepository['quoteSelection']
      >['executeTakeFirst']
    >
  >
>;

/** Convert the immutable SQL projection into exact first-party review terms. */
function quoteFromRecord(record: QuoteRecord): PaymentQuote {
  return {
    id: record.id,
    ownerId: record.owner_id,
    walletId: record.wallet_id,
    productId: record.product_id,
    serviceType: record.service_type as PaymentQuote['serviceType'],
    networkCode: record.network_code,
    billerCode: record.biller_code,
    electricityMeterType:
      record.electricity_meter_type as PaymentQuote['electricityMeterType'],
    bankBeneficiaryValidation:
      record.bank_beneficiary_validation_id === null
        ? null
        : {
            id: record.bank_beneficiary_validation_id,
            ownerId: record.owner_id,
            productId: record.product_id,
            bankId: record.beneficiary_bank_id!,
            bankCode: record.bank_code!,
            bankName: record.bank_name!,
            countryCode: record.country_code!,
            currency: record.bank_currency!,
            accountNumber: record.beneficiary_account_number!,
            accountName: record.account_name!,
            evidenceReference: record.bank_evidence!,
            verifiedAt: record.bank_verified_at!,
            expiresAt: record.bank_expires_at!,
          },
    narration: record.narration,
    accountValidation:
      record.account_validation_id === null
        ? null
        : {
            id: record.account_validation_id,
            ownerId: record.owner_id,
            productId: record.product_id,
            serviceType:
              record.service_type as BillAccountValidation['serviceType'],
            billerCode: record.biller_code!,
            electricityMeterType:
              record.electricity_meter_type as BillAccountValidation['electricityMeterType'],
            accountNumber: record.account_number!,
            customerName: record.customer_name!,
            serviceAddress: record.service_address,
            evidenceReference: record.validation_evidence_reference!,
            verifiedAt: record.verified_at!,
            expiresAt: record.validation_expires_at!,
          },
    educationPaymentType:
      record.education_payment_type as PaymentQuote['educationPaymentType'],
    educationPurpose: record.education_purpose,
    insuranceTerms:
      record.insurance_terms as unknown as InsuranceProductTerms | null,
    educationValidation:
      record.education_validation_id === null
        ? null
        : {
            id: record.education_validation_id,
            ownerId: record.owner_id,
            productId: record.product_id,
            institutionCode: record.biller_code!,
            paymentType:
              record.education_payment_type as EducationRecipientValidation['paymentType'],
            purpose: record.education_purpose!,
            beneficiaryIdentifier: record.beneficiary_identifier!,
            beneficiaryName: record.beneficiary_name!,
            evidenceReference: record.education_evidence!,
            verifiedAt: record.education_verified_at!,
            expiresAt: record.education_expires_at!,
          },
    insuranceApplication:
      record.insurance_application_id === null
        ? null
        : {
            id: record.insurance_application_id,
            ownerId: record.owner_id,
            productId: record.product_id,
            insuredProfile: record.insured_profile as unknown as InsuredProfile,
            termsVersion: record.terms_version!,
            acceptedTerms: true,
            eligibilityMode: (
              record.insurance_terms as unknown as InsuranceProductTerms
            ).eligibilityMode,
            coverageStartMode: (
              record.insurance_terms as unknown as InsuranceProductTerms
            ).coverageStartMode,
            coverageStartsOn: databaseDate(record.coverage_starts_on!),
            coverageEndsOn: databaseDate(record.coverage_ends_on!),
            evidenceReference: record.insurance_evidence!,
            createdAt: record.insurance_created_at!,
            expiresAt: record.insurance_expires_at!,
          },
    displayName: record.display_name,
    recipientPhoneNumber: record.recipient_phone_number,
    contactPhoneNumber: record.contact_phone_number ?? null,
    merchantRecipientIdentifier: record.merchant_recipient_identifier ?? null,
    principal: {
      currency: record.currency,
      amountMinorUnits: BigInt(record.principal_minor_units),
    },
    feeMinorUnits: BigInt(record.fee_minor_units),
    totalDebitMinorUnits: BigInt(record.total_debit_minor_units),
    allowanceLabel: record.allowance_label,
    validitySeconds: record.validity_seconds,
    providerKey: record.provider_key,
    providerProductCode: record.provider_product_code,
    createdAt: record.created_at,
    expiresAt: record.expires_at,
  };
}

/** Preserve SQL date-only values across pg's date parser without exposing driver representations in application contracts. */
function databaseDate(value: Date | string): string {
  if (typeof value === 'string') {
    return value;
  }
  return `${value.getFullYear().toString().padStart(4, '0')}-${(value.getMonth() + 1).toString().padStart(2, '0')}-${value.getDate().toString().padStart(2, '0')}`;
}

/** Map consent and preparation modes from its immutable product revision; no current provider observation is inferred. */
function insuranceFromRecord(
  record: import('kysely').Selectable<
    import('../../../infrastructure/database/database.generated.js').ServiceInsuranceApplications
  >,
  terms: InsuranceProductTerms,
): InsuranceApplication {
  return {
    id: record.id,
    ownerId: record.owner_id,
    productId: record.product_id,
    insuredProfile: record.insured_profile as unknown as InsuredProfile,
    termsVersion: record.terms_version,
    acceptedTerms: true,
    eligibilityMode: terms.eligibilityMode,
    coverageStartMode: terms.coverageStartMode,
    coverageStartsOn: databaseDate(record.coverage_starts_on),
    coverageEndsOn: databaseDate(record.coverage_ends_on),
    evidenceReference: record.evidence_reference,
    createdAt: record.created_at,
    expiresAt: record.expires_at,
  };
}
