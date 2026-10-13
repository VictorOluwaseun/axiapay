import type {
  ProductPage,
  ProductQuery,
  ServiceProduct,
} from '../../domain/service-product.js';

import type { Bank, BankPage, BankQuery } from '../../domain/bank.js';

/** Authoritative catalogue storage. Pricing and eligibility bypass cache; revisions never change financial terms in place. */
export interface ServiceCatalogRepository {
  /** List enabled immutable bank profiles by normalized effective currency/country filters and bounded revision-ID cursor; never infer provider availability. */
  listBanks(query: BankQuery): Promise<BankPage>;
  /** Return an enabled bank profile; historical beneficiary snapshots remain readable through payment storage after withdrawal. */
  getBank(bankId: string): Promise<Bank | null>;
  /** List enabled products in ascending revision-ID order using bounded keyset pagination. */
  listProducts(query: ProductQuery): Promise<ProductPage>;
  /** Read an enabled revision; missing and withdrawn products both return null. */
  getProduct(id: string): Promise<ServiceProduct | null>;
}
