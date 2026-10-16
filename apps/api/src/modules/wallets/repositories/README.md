# Wallet repositories

`contracts/wallet.repository.ts` defines domain-facing atomic transaction contracts. `WalletRepositoryImpl` coordinates PostgreSQL access through `WalletDataSource`. Entry triggers maintain balance projections; the data source never increments balances separately.

The shared financial repository and balance-by-ID endpoint bypass Redis. The shared `WalletSummaryRepositoryImpl` coordinates the existing PostgreSQL wallet snapshot source with an optional display-cache port, bound to signed Redis storage by API composition for owner/currency display lookup. Its hits perform no SQL. The separate invalidation repository delivers committed wallet/ledger outbox versions, retries failures and fences stale fills; see [the cache protocol](../wallet-summary-cache.md). Journal/outbox records commit together; dispatch remains future work. `DatabaseModule` owns and closes the shared pool. See the [wallet module contract](../README.md).
