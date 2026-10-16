import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../../../infrastructure/database/create-database.js';
import {
  bankFromRecord,
  productFromRecord,
} from '../../../infrastructure/database/mappers/service-catalog-record.mapper.js';
import type {
  ProductPage,
  ProductQuery,
  ServiceProduct,
} from '../domain/service-product.js';
import type { ServiceCatalogRepository } from './contracts/service-catalog.repository.js';
import type { Bank, BankPage, BankQuery } from '../domain/bank.js';

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
