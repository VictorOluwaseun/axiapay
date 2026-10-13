# API architecture

The API groups code by feature under `src/modules`. Each feature contains domain, application, infrastructure, and delivery boundaries. Its README defines ownership. `bootstrap` wires dependencies; root infrastructure holds shared connection, configuration, diagnostics, jobs, and outbox responsibilities. `shared` is limited to demonstrated shared domain values and application contracts.

Delivery calls use cases. Use cases invoke domain rules, repository contracts, and provider ports. Repository implementations coordinate concrete data sources. Kysely and ioredis stay in infrastructure; they are never passed to use cases or controllers. TypeScript database rows and transport DTOs must not leak into domain contracts.

For eligible reads, repositories implement cache-aside using canonical query parameters and authorized account scope. Writes invalidate every affected detail, collection, and summary after commit. Define durable invalidation recovery and stale-fill protection before implementing caching. Wallet authorization always uses authoritative database state. No cache implementation or financial transaction is supplied by this foundation.

A transaction boundary must bind participating repositories to the same database transaction. Provider calls require durable workflow progress and reconciliation rather than a long-running database transaction. API, SMS, bulk, and schedule paths must share logical payment identities.

Every named module, class, interface, function, and method documents its responsibility and delegation. Explain non-obvious constraints with comments; keep names and documentation current. ESLint enforces flat if-statement control flow and key layer import restrictions. These checks complement code review; they are not proof of all architectural rules.

The `health` module is the only active feature. `/health/live` confirms process liveness, not database, queue, or provider readiness. Future readiness checks must report those dependencies separately.

See the root AGENTS.md and [the technology and application structure draft](https://chatgpt.com/space/page_d527055d03a88191b1383b8d08883119) for the full engineering agreement.
