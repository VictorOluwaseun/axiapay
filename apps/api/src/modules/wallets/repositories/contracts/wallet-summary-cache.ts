import type { WalletSummaryCache as SummaryCache } from '@axiapay/payments-runtime/modules/wallets/repositories/contracts/wallet-summary-cache';
import type { RecoverableCache } from '../../../../shared/cache/recoverable-cache.js';

/** Combine the shared display-cache port with API-owned durable invalidation recovery controls. */
export interface WalletSummaryCache extends SummaryCache, RecoverableCache {}
