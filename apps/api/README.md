# AxiaPay API

NestJS and Fastify foundation for individual payments. The active routes are process liveness and development OpenAPI documentation. Feature directories establish ownership without placeholder financial endpoints.

## Local setup

Use Node.js 24.15 or newer within the 24.x release line and the workspace's pinned pnpm version. From the repository root:

```sh
pnpm install --frozen-lockfile
docker compose -f compose.api.yaml up -d --wait
cp -n apps/api/.env.example apps/api/.env
pnpm run dev:api
```

The root `dev:api` script starts only the API in watch mode. You can also invoke it with `npm run dev:api`; it delegates to the workspace's pinned pnpm toolchain.

The local environment contains development credentials only. Never use them in a deployment. Existing environment files must not be overwritten. The HTTP listener defaults to `127.0.0.1:4000`.

| Resource          | Local address                     |
| ----------------- | --------------------------------- |
| Liveness          | http://127.0.0.1:4000/health/live |
| API documentation | http://127.0.0.1:4000/docs        |
| OpenAPI JSON      | http://127.0.0.1:4000/docs-json   |
| PostgreSQL        | 127.0.0.1:55432                   |
| Redis cache       | 127.0.0.1:56379                   |
| Redis jobs        | 127.0.0.1:56380                   |
| Mailpit UI        | http://127.0.0.1:58025            |
| Mailpit SMTP      | 127.0.0.1:51025                   |

`docker compose -f compose.api.yaml stop` stops this project's services without deleting data. Application liveness does not assert data-source readiness. The API has no financial endpoints, authentication implementation, or provider integration yet.

## Validation

```sh
pnpm --filter @axiapay/api format:check
pnpm --filter @axiapay/api lint
pnpm --filter @axiapay/api check-types
pnpm --filter @axiapay/api test
pnpm --filter @axiapay/api build
pnpm --filter @axiapay/api test:integration
```

Integration tests require Docker and create disposable PostgreSQL and Redis containers. They do not use the local development database. Build output is `dist/`. `pnpm --filter @axiapay/api start` starts the compiled application.

The initial setup passed formatting, linting, type checking, the compiled build, nine configuration/HTTP tests, and two disposable PostgreSQL/Redis integration tests. The migration runner and the live health and OpenAPI routes were also verified. These checks validate the foundation, not payment or authentication behaviour.

The API has its own Turborepo configuration for build outputs and runtime environment variables. Existing web and documentation applications keep their own configuration.

## Layout and dependencies

See [architecture](docs/architecture.md), [the foundation decision](docs/decisions/0001-api-foundation.md), and each feature's README. `package.json` records exact versions. Kysely/pg provide SQL access; ioredis provides cache connectivity; BullMQ is available for future workers. Config/Zod validate settings; Pino supplies redacted diagnostics; Argon2 and jose are available for authentication implementation. A validated configuration never logs invalid supplied values.

Migrations are explicit: after building, run `pnpm --filter @axiapay/api db:migrate`. See [migration responsibilities](migrations/README.md). No financial tables are included. Generate database types with `db:types` after reviewed schema changes.
