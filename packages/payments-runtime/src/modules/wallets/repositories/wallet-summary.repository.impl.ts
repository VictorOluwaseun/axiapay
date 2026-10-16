import type { WalletDataSource } from '../data-sources/wallet.data-source.js';
import type { WalletSummaryRepository } from './contracts/wallet-summary.repository.js';
import type { WalletSummaryCache } from './contracts/wallet-summary-cache.js';
import type { WalletSummary } from '../domain/wallet-summary.js';

/** Coordinate the committed PostgreSQL snapshot and an optional fenced cache; financial repositories continue to bypass this display cache. */
export class WalletSummaryRepositoryImpl implements WalletSummaryRepository {
  /** Borrow lifecycle-managed storage through the existing wallet data source and the optional display cache port; absent cache means PostgreSQL-only lookup. */
  constructor(
    private readonly source: WalletDataSource,
    private readonly cache?: WalletSummaryCache,
  ) {}

  /** Cache existing owner/currency results only; a missing wallet remains discoverable immediately after provisioning. */
  async findByOwner(
    ownerId: string,
    currency: string,
  ): Promise<WalletSummary | null> {
    const readAt = new Date();
    const cached = await this.cache?.read(ownerId, currency, readAt);
    if (cached?.snapshot) {
      return cached.snapshot;
    }
    const row = await this.source.readWalletByOwner(ownerId, currency);
    if (!row) {
      return null;
    }
    const wallet: WalletSummary = {
      id: row.id,
      ownerId: row.owner_id,
      currency: row.currency,
      walletStatus: row.wallet_status as WalletSummary['walletStatus'],
      availableMinorUnits:
        BigInt(row.available_credits) - BigInt(row.available_debits),
      reservedMinorUnits:
        BigInt(row.reserved_credits) - BigInt(row.reserved_debits),
    };
    if (cached && this.cache) {
      await this.cache.write(wallet, readAt, cached.ticket);
    }
    return wallet;
  }
}
