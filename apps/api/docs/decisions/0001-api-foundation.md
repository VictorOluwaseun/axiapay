# API foundation

Status: Adopted for the initial setup on 13 October 2026.

Use Node.js 24, NestJS 12 with Fastify, Kysely, PostgreSQL, and ioredis. Keep domain policies and capability contracts framework-independent; services own workflows by default, as recorded in [the current layout decision](0004-feature-module-layout.md). The initial application is a cohesive set of feature modules; background workers can later use the same modules without duplicating financial rules.

Pin API TypeScript to 6.0.3 because the selected Swagger and typescript-eslint releases support TypeScript 6. Existing web packages keep their own TypeScript versions. Pin direct API dependencies and commit the workspace lockfile for reproducible installation.

Vitest uses SWC for Nest decorator metadata. PostgreSQL and Redis integration checks use disposable Testcontainers instances. Local Compose runs a separate evictable cache and a persistent noeviction Redis queue instance. These are development services bound to loopback, not a production deployment design.

Argon2, jose, BullMQ, and notification development tooling are installed for the planned features; authentication, queues, SMS processing, cache repositories, and financial workflows are not implemented by setup.

The upstream ioredis project describes maintenance as best effort and recommends node-redis for new applications. ioredis remains the user's selected client; verify compatibility on upgrades. Review cache consistency, outbox delivery, ledger schema, and authorization protocols before feature implementation.
