# Stack practices

These rules describe how each selected tool fits AxiaPay. Some capabilities are already running; others become applicable when their feature is implemented. Versions are pinned in application manifests and the workspace lockfile. Check official guidance and compatibility before upgrading.

## NestJS and Fastify

Use feature modules, constructor injection, and explicit provider tokens. Export services and guards as feature entry points. Services own workflows by default through repository contracts; repositories own persistence directly or through optional data sources. Extract a framework-independent use case only when a complex workflow benefits from its own orchestration boundary. Prefer lifecycle hooks for connection ownership, pipes for DTO validation, guards for request authentication, filters for safe errors, and interceptors for transport concerns. Do not duplicate these mechanisms in controllers.

HTTP DTOs use `class-validator`, `class-transformer`, and the global strict `ValidationPipe`, created by the same factory used by `withValidatedInput` for untrusted non-HTTP payloads. Services consume validated commands and implement business rules; input shape and normalization belong to DTOs/pipes or adapter mappers. Keep runtime DTO imports intact for decorator metadata. Explicitly validate nested objects and reject unknown fields. Disable implicit credential conversion. OpenAPI uses those DTO classes. Config/Zod validates environment settings separately. Pino logs request references and redacts sensitive input. Follow the [Nest validation](https://docs.nestjs.com/techniques/validation) and [provider](https://docs.nestjs.com/fundamentals/custom-providers) guidance.

## PostgreSQL and Kysely

Use generated schema types, parameterized queries, bounded pools, reviewed migrations, and database constraints. Bind participating repositories and optional data sources to the same transaction connection. Kysely's [transaction callback](https://kysely.dev/docs/examples/transactions/simple-transaction) commits on success and rolls back on an exception. Failed authentication guesses intentionally return a failure result inside the transaction so their counters commit before the service throws.

Use exact minor units for money, unique logical request identities, deterministic lock ordering, and atomic ledger writes. Do not hold a database transaction open while calling an external payment provider. Run real PostgreSQL integration checks for concurrency, duplicate requests, rollback, and restricted runtime permissions. Repositories may coordinate storage but must not take over business workflows.

## ioredis

Keep cache access in concrete repositories or optional cache data sources, with cache policy owned by repositories. Keys encode normalized effective query parameters and authorized scope; always set expiry. Invalidate relevant cached results after successful writes, including collections and summaries. Each cached feature must define durable invalidation recovery and stale-fill protection. Current authentication and wallet authorization bypass Redis.

Use distinct cache and queue connections. Configure retries, timeouts, error events, and shutdown to match the operation. Pipeline independent cache operations when useful; use Redis transactions or scripts for actual Redis atomicity rather than assuming a pipeline supplies it. See the [ioredis documentation](https://github.com/redis/ioredis).

## BullMQ

BullMQ is installed and a separate persistent queue Redis is configured locally; no worker workflow is implemented yet. Add Nest queue integration when a real workflow needs producers and consumers, following [Nest queues](https://docs.nestjs.com/techniques/queues). Processors call feature services, which may use a justified extracted workflow; jobs carry stable logical IDs and minimal sensitive data.

Design for retries and duplicate execution. Use bounded attempts, backoff, concurrency limits, observable terminal failures, and graceful shutdown. Database state remains authoritative. Publish committed work through an outbox where losing a job would lose a business action. A delayed job does not settle a payment or guarantee exact timing.

Use Redis persistence and `noeviction` for queues. Producers should fail within a bounded time when Redis is unavailable; workers need reconnection behaviour suitable for continued consumption. Follow [BullMQ production guidance](https://docs.bullmq.io/guide/going-to-production).

## Next.js and React

The web and documentation apps remain scaffolds while API work proceeds. For new screens, use App Router layouts and Server Components for server-side reads and rendering. Add Client Components where state, interaction, or browser APIs are needed; keep the client boundary small. Keep secrets out of client bundles. This follows the [Next.js component guidance](https://nextjs.org/docs/app/getting-started/server-and-client-components).

Nest remains authoritative for authentication, payments, permissions, pricing, and wallet operations. Server Actions and Route Handlers, when needed, are adapters to those API contracts. Do not recreate business rules or access payment tables directly from the web app. Never place per-user financial or session responses in a shared public cache. Choose browser session handling and mutation protection when the authenticated web client is built.

## Verification

Use Vitest and Nest testing modules for contracts and behaviour, with SWC preserving decorator metadata. Use disposable PostgreSQL, Redis, and Mailpit containers for integration checks. Run API lint, type checking, tests, formatting, and build for relevant changes. Use the workspace's pinned pnpm toolchain; keep lockfile changes reviewable.
