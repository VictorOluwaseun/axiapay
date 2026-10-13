import { Inject, Injectable } from '@nestjs/common';
import type {
  ProductPage,
  ProductQuery,
  ServiceProduct,
} from '../domain/service-product.js';
import type { ServiceCatalogRepository } from '../repositories/contracts/service-catalog.repository.js';
import { SERVICE_CATALOG } from '../service-catalog.tokens.js';
import {
  PaymentError,
  assertUuidReference,
} from '../../payments/domain/payment.js';

import type { Bank, BankPage, BankQuery } from '../domain/bank.js';

/** Own first-party product discovery and eligibility; keep biller/meter identity explicit and never expose provider credentials or infer a network from a phone prefix. */
@Injectable()
export class ServiceCatalogService {
  /** Inject the authoritative catalogue contract, leaving SQL access private. */
  constructor(
    @Inject(SERVICE_CATALOG.repository)
    private readonly catalogue: ServiceCatalogRepository,
  ) {}

  /** Validate internal callers as well as HTTP callers before issuing a bounded query. */
  listProducts(query: ProductQuery): Promise<ProductPage> {
    if (
      !Number.isInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 100
    ) {
      throw new PaymentError('INVALID_PAYMENT');
    }
    if (
      query.serviceType !== undefined &&
      ![
        'airtime',
        'data',
        'tv',
        'electricity',
        'education',
        'insurance',
        'bank_transfer',
      ].includes(query.serviceType)
    ) {
      throw new PaymentError('INVALID_PAYMENT');
    }
    if (
      query.networkCode !== undefined &&
      !/^[a-z0-9][a-z0-9-]{0,49}(?![\s\S])/.test(query.networkCode)
    ) {
      throw new PaymentError('INVALID_PAYMENT');
    }
    if (query.bankId !== undefined) {
      assertUuidReference(query.bankId);
    }
    if (
      query.currency !== undefined &&
      (typeof query.currency !== 'string' ||
        !/^[A-Z]{3}(?![\s\S])/.test(query.currency))
    ) {
      throw new PaymentError('INVALID_PAYMENT');
    }
    if (query.afterId !== undefined) {
      assertUuidReference(query.afterId);
    }
    if (
      query.billerCode !== undefined &&
      !/^[a-z0-9][a-z0-9-]{0,49}(?![\s\S])/.test(query.billerCode)
    ) {
      throw new PaymentError('INVALID_PAYMENT');
    }
    if (
      query.electricityMeterType !== undefined &&
      !['prepaid', 'postpaid'].includes(query.electricityMeterType)
    ) {
      throw new PaymentError('INVALID_PAYMENT');
    }
    return this.catalogue.listProducts(query);
  }

  /** Validate normalized filters for internal and HTTP callers; bank discovery never performs name enquiry or a transfer. */
  listBanks(query: BankQuery): Promise<BankPage> {
    if (
      !Number.isInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 100
    ) {
      throw new PaymentError('INVALID_PAYMENT');
    }
    if (
      query.currency !== undefined &&
      (typeof query.currency !== 'string' ||
        !/^[A-Z]{3}(?![\s\S])/.test(query.currency))
    ) {
      throw new PaymentError('INVALID_PAYMENT');
    }
    if (
      query.countryCode !== undefined &&
      (typeof query.countryCode !== 'string' ||
        !/^[A-Z]{2}(?![\s\S])/.test(query.countryCode))
    ) {
      throw new PaymentError('INVALID_PAYMENT');
    }
    if (query.afterId !== undefined) {
      assertUuidReference(query.afterId);
    }
    return this.catalogue.listBanks(query);
  }

  /** Require a published first-party bank profile for fresh recipient verification; historical payment reads do not depend on current publication. */
  async getBank(bankId: string): Promise<Bank> {
    assertUuidReference(bankId);
    const bank = await this.catalogue.getBank(bankId);
    if (!bank) {
      throw new PaymentError('BANK_UNAVAILABLE');
    }
    return bank;
  }

  /** Require an enabled immutable revision; withdrawn products cannot receive fresh quotes. */
  async getProduct(id: string): Promise<ServiceProduct> {
    assertUuidReference(id);
    const product = await this.catalogue.getProduct(id);
    if (!product) {
      throw new PaymentError('PRODUCT_UNAVAILABLE');
    }
    return product;
  }
}
