import type { Kysely, Selectable } from 'kysely';
import type { DatabaseSchema } from '../../../infrastructure/database/create-database.js';
import type {
  BankTransferBanks,
  ServiceCatalogProducts,
} from '../../../infrastructure/database/database.generated.js';
import type {
  ProductPage,
  ProductQuery,
  ServiceProduct,
} from '../domain/service-product.js';
import type { ServiceCatalogRepository } from './contracts/service-catalog.repository.js';
import type { InsuranceProductTerms } from '../domain/insurance-product-terms.js';

import type { Bank, BankPage, BankQuery } from '../domain/bank.js';

/** Keep SQL names and exact bigint conversion inside the catalogue infrastructure boundary. */
export function productFromRecord(
  record: Selectable<ServiceCatalogProducts>,
): ServiceProduct {
  return {
    id: record.id,
    serviceType: record.service_type as ServiceProduct['serviceType'],
    networkCode: record.network_code,
    billerCode: record.biller_code,
    electricityMeterType:
      record.electricity_meter_type as ServiceProduct['electricityMeterType'],
    bankId: record.bank_id,
    bankBeneficiaryValidationLifetimeSeconds:
      record.bank_beneficiary_validation_lifetime_seconds,
    accountValidationLifetimeSeconds:
      record.account_validation_lifetime_seconds,
    educationPaymentType:
      record.education_payment_type as ServiceProduct['educationPaymentType'],
    educationPurpose: record.education_purpose,
    educationValidationLifetimeSeconds:
      record.education_validation_lifetime_seconds,
    insuranceTerms:
      record.insurance_terms as unknown as InsuranceProductTerms | null,
    insuranceApplicationLifetimeSeconds:
      record.insurance_application_lifetime_seconds,
    displayName: record.display_name,
    currency: record.currency,
    fixedPriceMinorUnits:
      record.fixed_price_minor_units === null
        ? null
        : BigInt(record.fixed_price_minor_units),
    minimumAmountMinorUnits: BigInt(record.minimum_amount_minor_units),
    maximumAmountMinorUnits: BigInt(record.maximum_amount_minor_units),
    amountStepMinorUnits: BigInt(record.amount_step_minor_units),
    feeMinorUnits: BigInt(record.fee_minor_units),
    allowanceLabel: record.allowance_label,
    validitySeconds: record.validity_seconds,
    quoteLifetimeSeconds: record.quote_lifetime_seconds,
    providerKey: record.provider_key,
    providerProductCode: record.provider_product_code,
    isEnabled: record.is_enabled,
  };
}

/** Borrow the shared PostgreSQL pool for immediately consistent pricing/eligibility reads; no cache or invalidation protocol is involved. */
export class PostgresServiceCatalogRepository implements ServiceCatalogRepository {
  /** Connection lifecycle belongs to DatabaseModule, not individual catalogue reads. */
  constructor(private readonly database: Kysely<DatabaseSchema>) {}

  /** @inheritdoc ServiceCatalogRepository.listBanks */
  async listBanks(query: BankQuery): Promise<BankPage> {
    let selection = this.database
      .selectFrom('bank_transfer_banks')
      .selectAll()
      .where('is_enabled', '=', true);
    if (query.currency) {
      selection = selection.where('currency', '=', query.currency);
    }
    if (query.countryCode) {
      selection = selection.where('country_code', '=', query.countryCode);
    }
    if (query.afterId) {
      selection = selection.where('id', '>', query.afterId);
    }
    const records = await selection
      .orderBy('id')
      .limit(query.limit + 1)
      .execute();
    const banks = records.slice(0, query.limit).map(bankFromRecord);
    return {
      banks,
      nextCursor: records.length > query.limit ? banks.at(-1)!.id : null,
    };
  }

  /** @inheritdoc ServiceCatalogRepository.getBank */
  async getBank(bankId: string): Promise<Bank | null> {
    const record = await this.database
      .selectFrom('bank_transfer_banks')
      .selectAll()
      .where('id', '=', bankId)
      .where('is_enabled', '=', true)
      .executeTakeFirst();
    return record ? bankFromRecord(record) : null;
  }

  /** @inheritdoc ServiceCatalogRepository.listProducts */
  async listProducts(query: ProductQuery): Promise<ProductPage> {
    let selection = this.database
      .selectFrom('service_catalog_products as product')
      .leftJoin('bank_transfer_banks as bank', 'bank.id', 'product.bank_id')
      .selectAll('product')
      .where('product.is_enabled', '=', true)
      .where((expression) =>
        expression.or([
          expression('product.bank_id', 'is', null),
          expression('bank.is_enabled', '=', true),
        ]),
      );
    if (query.serviceType) {
      selection = selection.where(
        'product.service_type',
        '=',
        query.serviceType,
      );
    }
    if (query.networkCode) {
      selection = selection.where(
        'product.network_code',
        '=',
        query.networkCode,
      );
    }
    if (query.billerCode) {
      selection = selection.where('product.biller_code', '=', query.billerCode);
    }
    if (query.electricityMeterType) {
      selection = selection.where(
        'electricity_meter_type',
        '=',
        query.electricityMeterType,
      );
    }
    if (query.bankId) {
      selection = selection.where('product.bank_id', '=', query.bankId);
    }
    if (query.currency) {
      selection = selection.where('product.currency', '=', query.currency);
    }
    if (query.afterId) {
      selection = selection.where('product.id', '>', query.afterId);
    }
    const records = await selection
      .orderBy('product.id')
      .limit(query.limit + 1)
      .execute();
    const products = records.slice(0, query.limit).map(productFromRecord);
    return {
      products,
      nextCursor: records.length > query.limit ? products.at(-1)!.id : null,
    };
  }

  /** @inheritdoc ServiceCatalogRepository.getProduct */
  async getProduct(id: string): Promise<ServiceProduct | null> {
    const record = await this.database
      .selectFrom('service_catalog_products as product')
      .leftJoin('bank_transfer_banks as bank', 'bank.id', 'product.bank_id')
      .selectAll('product')
      .where('product.id', '=', id)
      .where('product.is_enabled', '=', true)
      .where((expression) =>
        expression.or([
          expression('product.bank_id', 'is', null),
          expression('bank.is_enabled', '=', true),
        ]),
      )
      .executeTakeFirst();
    return record ? productFromRecord(record) : null;
  }
}

/** Map immutable bank profile storage into first-party directory terms without leaking driver types. */
export function bankFromRecord(record: Selectable<BankTransferBanks>): Bank {
  return {
    id: record.id,
    bankCode: record.bank_code,
    displayName: record.display_name,
    countryCode: record.country_code,
    currency: record.currency,
    minimumAccountNumberLength: record.minimum_account_number_length,
    maximumAccountNumberLength: record.maximum_account_number_length,
    isEnabled: record.is_enabled,
  };
}
