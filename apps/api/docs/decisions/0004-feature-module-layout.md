# Feature module layout and Nest integration

Status: Adopted and amended on 13 October 2026 at the user's request. This replaces the earlier mandatory use-case, data-source, and feature-folder naming proposals.

Organize modules with `controllers`, `services`, and `repositories`, supported by `domain`, `dtos`, optional `data-sources`, and focused adapters. Services own workflows by default and call repository contracts. Preserve inward dependencies, repository-owned data access, flat control flow, and responsibility documentation.

Repository contracts remain the persistence boundary. A concrete repository can execute Kysely and ioredis operations directly. Separate data sources are optional: extract them for substantial storage logic, reuse, or a clear responsibility across multiple stores, not to forward every method unchanged. Services, controllers, domain code, and repository contracts remain independent of storage clients. Cache-aside and invalidation policy belongs to repositories in either layout.

Authentication's SQL implementation is merged into `AuthenticationRepositoryImpl`, removing its forwarding layer and extra Nest provider. The repository borrows the shared pool, maps rows to domain contracts, coordinates Redis session caching and reuses the current transaction connection. Credentials and transaction-local reads bypass cache. The implementation name reflects responsibility across both stores; data-source names describe their feature responsibility, with storage technology documented inside infrastructure. Wallets keep `WalletDataSource` because ledger queries and locking are a substantial storage responsibility; its repository still coordinates transactions and domain mapping. Existing transaction, concurrency, and rollback guarantees remain in place.

Use-case classes are optional. Extract a complex workflow when independent orchestration clarifies several business stages, cross-feature coordination, or recovery/state rules. Code length can reveal a problem but is not sufficient justification. Small service methods and shared domain policies remain the first tools for keeping code focused.

Remove the per-action use-case classes and mandatory folders from the current API. Authentication code issuance/redemption shares one cohesive service; password login and sessions belong to the authentication service. Wallet provisioning, balances, funding, and transfers belong to the wallet service; the reservation service handles the held-money lifecycle. Health answers liveness directly. Existing authorization, concurrency, idempotency, and recovery behaviour remains unchanged.

Use `class-validator` and `class-transformer` DTOs with Nest's global `ValidationPipe`, strict unknown-field rejection, nested validation, and no implicit primitive conversion. Swagger describes the same DTOs. Keep Zod for environment configuration. Preserve password whitespace, leading-zero codes, safe error responses, and the existing public routes.

Replace the combined authentication resources object with separate Nest providers. `DatabaseModule` owns the shared SQL pool. Authentication exports its service and guard. Wallets use a Nest dynamic module requiring explicit trusted verifier adapters and export `WalletService`; no unverified wallet routes are added.

Redis caching, BullMQ workers, and Next.js UI capabilities are used where their workflows require them. Transactional authentication and spending decisions keep authoritative database reads; session identity hits use repository-owned cache-aside. This refactor does not introduce production messaging, queue execution, or web authentication screens. See [stack practices](../stack-practices.md).
