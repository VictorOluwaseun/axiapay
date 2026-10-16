# Current-account wallet summary

`GET /v1/wallets/me?currency=NGN` requires a bearer session. `@AuthenticatedAccount()` supplies the owner; clients cannot select a different account. Currency is required, must be three uppercase letters, and unknown query properties are rejected. A missing wallet returns `404 WALLET_NOT_FOUND`; GET never creates it. Signup verification provisions NGN, and explicit wallet creation remains idempotent.

The response is `{ id, currency, walletStatus, availableMinorUnits, reservedMinorUnits, totalMinorUnits }`. Amounts are exact decimal strings in minor units. Available plus reserved equals total. The response sets `Cache-Control: no-store` and `Pragma: no-cache` to keep private summaries out of client/intermediary caches; server Redis caching is independent.

## Ownership and cache policy

`WalletService.getWalletByOwner` handles existing-wallet discovery through shared wallet contracts. The shared `WalletSummaryRepositoryImpl` owns cache-aside policy: read Redis, query the existing PostgreSQL wallet snapshot source on a miss, then conditionally populate Redis. Its key identity includes the authenticated account, exact currency and database-owned namespace. A valid hit performs no wallet SQL. Missing wallets are not cached. `WalletModule` defaults to PostgreSQL-only lookup for workers and other callers. The API composes `WalletModule.withSummaryCache` with `WalletSummaryCacheModule`, which owns Redis connections and invalidation recovery. Wallet services receive no Redis client or recovery dependency.

The cache stores a signed, credential-free display projection with no ledger account IDs. Signatures bind the account/currency scope, payload, namespace, epoch and generation under a wallet-specific signing domain. Account scopes in Redis keys are hashed. Corruption, copied records, unknown fields, expiry and generation mismatches become misses. Expiry is at most 15 seconds from the start of the read; slow database reads cannot extend it. Redis uses the managed 150 ms connection/command deadlines, no offline queuing, and explicit reconnect recovery.

`GET /v1/wallets/:walletId/balance` remains authoritative. Transfers, reservations, funding and settlement always use PostgreSQL and never consume the display cache. A cached wallet status or balance cannot authorize spending.

## Committed invalidation and recovery

Migration 0015 installs triggers on wallet insertion/update and ledger-balance insertion/update. They coalesce affected owner/currency scopes in `wallet_summary_cache_invalidations` within the business transaction. Rollbacks publish nothing. Trigger/outbox failure rolls back the mutation. The existing financial schema prohibits wallet identity changes, wallet/ledger deletion and truncation, so these cannot silently remove a cached summary through normal SQL operations. A separate ledger notification outbox is unrelated to cache delivery.

After HTTP mutation handlers complete or fail, an API infrastructure interceptor requests bounded outbox delivery directly through its invalidation contract. This includes holds committed before an uncertain provider outcome. Delivery rotates Redis fences and deletes affected summaries, then acknowledges only the delivered outbox version; a newer concurrent event survives. Startup and one-second periodic recovery also handle worker and administrative changes. Each attempt handles at most four batches of 256 entries. An instance bypasses cache until startup/reconnect replay succeeds, and during failed recovery or a remaining backlog.

Recovery owns one dedicated PostgreSQL connection, with acquisition 250 ms, server statement 250 ms, lock 100 ms and client query 500 ms limits. An attempt has a one-second query deadline; HTTP callers await at most 250 ms while bounded delivery continues. Redis failures leave events durable for retry. Failures produce redacted diagnostics without customer identifiers. Cache loss is safe; outbox loss is not a supported recovery shortcut.

Reads capture an epoch/generation before querying PostgreSQL. Atomic Lua fills succeed only under that same fence. Delivered invalidation, marker eviction, namespace reset or reconnect recovery rejects older fills. Reconnect rotates the epoch even if the outbox is empty, protecting against stale Redis failover state. Authentication and wallet summaries share this fencing and delivery machinery while retaining separate namespaces, payloads and outboxes.

## Consistency and deployment

This is a display cache with a commit-to-delivery consistency window. Other API replicas can briefly display an older summary before invalidation, especially during an outage; worker writes are normally discovered on the next one-second recovery tick. The expiry bounds the age of any populated snapshot to 15 seconds under normal clock operation. An already-running read can return its earlier committed snapshot. Use the balance-by-ID endpoint when immediate consistency is required.

Apply migration 0015 before deploying. As migration owner, grant each API runtime role with `select grant_wallet_summary_cache_runtime_access('your_runtime_role')`. The role receives SELECT/DELETE on the outbox, not namespace writes or financial mutation privileges. Wallet/ledger mutation roles execute security-definer triggers with a fixed search path. The API must not own these tables in production.

After a database restore, rotate the database namespace as an administrative operation and clear the wallet-summary Redis namespace before resuming traffic. Do not connect restored databases and live databases to the same cache namespace. Restore procedures must preserve durable pending events or deliberately reset the cache namespace; TTL is not an invalidation recovery mechanism.

The integration suite uses independent API, Redis client/cache and PostgreSQL pools with a restricted runtime role. It covers account/currency isolation, SQL-free hits, validation, missing wallets, session rejection, mutation and worker invalidation, rollback, failed enqueue, bounded delivery, restart/periodic recovery, version-safe acknowledgement, and stale fills after invalidation or marker/cache eviction.
