# Wallet repositories

`contracts/wallet.repository.ts` defines domain-facing atomic transaction contracts. `WalletRepositoryImpl` coordinates PostgreSQL access through `WalletPostgresDataSource`. Entry triggers maintain balance projections; the data source never increments balances separately.

All implemented wallet reads require immediate consistency and bypass Redis. No wallet cache keys or invalidation protocol are introduced. Journal/outbox records commit together; dispatch remains future work. `DatabaseModule` owns and closes the shared pool. See the [wallet module contract](../README.md).
