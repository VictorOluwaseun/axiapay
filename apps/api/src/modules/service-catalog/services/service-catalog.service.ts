import { Inject, Injectable } from '@nestjs/common';
import type {
  ProductPage,
  ProductQuery,
  ServiceProduct,
} from '../domain/service-product.js';
import type { ServiceCatalogRepository } from '../repositories/contracts/service-catalog.repository.js';
import { SERVICE_CATALOG } from '../service-catalog.tokens.js';
import { PaymentError } from '../../payments/domain/payment.js';

import type { Bank, BankPage, BankQuery } from '../domain/bank.js';

/** Own first-party product discovery and eligibility; keep biller/meter identity explicit and never expose provider credentials or infer a network from a phone prefix. */
@Injectable()
export class ServiceCatalogService {
  /** Inject the authoritative catalogue contract, leaving SQL access private. */
  constructor(
    @Inject(SERVICE_CATALOG.repository)
    private readonly catalogue: ServiceCatalogRepository,
  ) {}

  /** Discover published products using adapter-validated, normalized filters and a bounded page size. */
  listProducts(query: ProductQuery): Promise<ProductPage> {
    return this.catalogue.listProducts(query);
  }

  /** Discover published banks using adapter-validated, normalized filters; discovery performs no transfer or name enquiry. */
  listBanks(query: BankQuery): Promise<BankPage> {
    return this.catalogue.listBanks(query);
  }

  /** Require a published first-party bank profile for fresh recipient verification; historical payment reads do not depend on current publication. */
  async getBank(bankId: string): Promise<Bank> {
    const bank = await this.catalogue.getBank(bankId);
    if (!bank) {
      throw new PaymentError('BANK_UNAVAILABLE');
    }
    return bank;
  }

  /** Require an enabled immutable revision; withdrawn products cannot receive fresh quotes. */
  async getProduct(id: string): Promise<ServiceProduct> {
    const product = await this.catalogue.getProduct(id);
    if (!product) {
      throw new PaymentError('PRODUCT_UNAVAILABLE');
    }
    return product;
  }
}
