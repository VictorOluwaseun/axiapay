# Wallet ledger foundation

Status: Implemented for the first wallet increment on 13 October 2026.

AxiaPay maintains customer balances internally. Partners supply verified funding and payout evidence. Keep the wallet subledger in PostgreSQL alongside its idempotency records, reservations, and outbox so one database transaction can protect each financial action. For wallets, retain Kysely queries in `WalletDataSource` behind `WalletRepositoryImpl`. Ledger queries, locking, and journal persistence justify this storage boundary; other features may use direct repository SQL under the [current layout decision](0004-feature-module-layout.md).

Each wallet has two customer-liability accounts: available and reserved. Reservations are posted transfers between these accounts, giving them the same immutable history as funding, spending, and internal transfers. A separate reservation record binds the held amount to a payment and permits exactly one full resolution. No additional held amount is subtracted from the available account.

Journal entries are append-only and balanced per currency. Entry triggers maintain balance projections synchronously, reject negative customer balances, and reject additions to committed journals. Deferred checks validate complete wallet creation, balanced journals, operation/outbox completion, and reservation consistency. Domain and application code own authorization and posting policy; database checks independently protect accounting invariants.

A repository transaction port keeps service workflows independent of Kysely. Wallet locks serialize competing spends, and unique request claims serialize duplicate submissions. Read-committed transactions with explicit locks are sufficient for these implemented operations because decisions depend on locked wallet/reservation rows and unique identities. New operations with additional predicate-based invariants must review their lock/isolation requirements rather than assuming this remains sufficient.

Authoritative balances, spending and reservation decisions bypass Redis. The API now offers an owner/currency display lookup with a separate [signed cache and durable invalidation protocol](../../src/modules/wallets/wallet-summary-cache.md). Financial workflows never consume that display cache. PostgreSQL outbox rows are durable notification intent, not completed job delivery.

Trusted funding and outcome verification ports are mandatory. The module provides no fabricated partner integration or wallet HTTP mutation endpoint. Settlement currently supports verified final success with a known partner debit, or verified failure safe to release. Unknown outcomes retain held funds. Earlier partner deductions, late reversals, refunds, partial settlements, external reconciliation, provider execution, limits, and payment authorization records require subsequent integration work.

Wallet owners are opaque authenticated subject identifiers. The identity/account integration must bind them to its canonical subject before exposing routes; no separate customer/account subsystem is invented by this migration. Runtime database roles use the migration's restricted grant function and must not own the tables.

Financial migrations have no automatic destructive down migration. Changes to historical accounting use reviewed forward migrations and compensating entries. This module currently has no public correction/refund posting workflow.

References: [Kysely transactions](https://kysely.dev/docs/examples/transactions/simple-transaction), [PostgreSQL locking](https://www.postgresql.org/docs/current/explicit-locking.html), [PostgreSQL constraint triggers](https://www.postgresql.org/docs/current/sql-createtrigger.html).
