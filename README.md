# AxiaPay

AxiaPay is being built for wallet-funded airtime, data, and bill payments, with transfers, bulk payments, scheduled transactions, and notifications. The MVP serves individuals; agent and business features are future scope. The first offline payment pilot will cover airtime and data through an SMS gateway.

Development currently focuses on the API and its separate background worker. Authentication supports verified phone or email signup, password and one-time-code login, and revocable sessions. Codes are captured locally in Mailpit for development. The application also provides wallet operations, first-party airtime/data/TV/electricity/education/insurance/bank-transfer catalogue, recipient verification and quote APIs, duplicate-safe payment submission/recovery, liveness, OpenAPI documentation, migrations, and tests. Service fulfilment adapters and real SMS delivery remain to be connected; absent adapters disable purchases before funds are held. See the [payment contract guide](apps/api/src/modules/payments/README.md).

## Project structure

```text
apps/
  api/                     NestJS and Fastify API
    src/
      bootstrap/           Application composition and dependency wiring
      modules/             HTTP features and API-owned workflows
      infrastructure/      API configuration, migrations, and diagnostics
      shared/              Shared domain values and capability contracts
    migrations/            Reviewed database migrations
    tests/                 HTTP and persistence integration checks
    docs/                  Architecture and implementation decisions
  worker/                  Standalone Nest/BullMQ recovery process (no HTTP listener)
  web/                     Next.js web application scaffold
  docs/                    Next.js documentation application scaffold
packages/
  backend/                 Shared payment/wallet/catalogue rules, workflows and adapters
  ui/                      Shared React components
  eslint-config/           Shared web lint configuration
  typescript-config/       Shared TypeScript configuration
compose.api.yaml           Local PostgreSQL, Redis, and Mailpit services
```

The web and documentation applications still contain starter screens. The API uses its own lint configuration to enforce its layer boundaries and control-flow rules.

## Technology

| Responsibility                | Tools                                                                |
| ----------------------------- | -------------------------------------------------------------------- |
| Workspace                     | pnpm and Turborepo                                                   |
| API                           | Node.js 24, TypeScript 6, NestJS, Fastify                            |
| Database                      | PostgreSQL, Kysely, pg, kysely-codegen                               |
| Cache and jobs                | ioredis, BullMQ; separate Redis instances for cache and queues       |
| HTTP validation               | class-validator, class-transformer, Nest ValidationPipe              |
| Configuration and diagnostics | Zod, Nest Config, Pino                                               |
| Authentication libraries      | Argon2id and Node.js cryptography for passwords, codes, and sessions |
| Development checks            | ESLint, Prettier, Vitest, SWC, Testcontainers                        |
| Web scaffolds                 | Next.js, React, TypeScript 7                                         |

Exact dependency versions are recorded in each application's `package.json` and the workspace lockfile. See the [API foundation decision](apps/api/docs/decisions/0001-api-foundation.md) for compatibility choices.

## Run locally

Install Node.js **24.15 or newer within the 24.x release line**, **pnpm 11.25.0**, and Docker with Docker Compose. Start Docker before bringing up the local services. Run these commands from the repository root:

```sh
pnpm install --frozen-lockfile
docker compose -f compose.api.yaml up -d --wait
cp -n apps/api/.env.example apps/api/.env
cp -n apps/worker/.env.example apps/worker/.env
pnpm --filter @axiapay/api auth:setup
pnpm run build:api
pnpm --filter @axiapay/api db:migrate
npm run dev
```

The environment copy preserves an existing `.env` file. The example contains local development credentials; deployment environments require their own configuration.

`npm run dev` starts the API, recovery worker, web application on port 3000, and documentation application on port 3001 together. Turborepo builds the shared backend before starting the API and worker, then rebuilds shared code and restarts those applications when it changes. Keep the Docker Compose services running for PostgreSQL, Redis and Mailpit; apply migrations explicitly during setup.

To run just the API or worker, use the focused commands instead:

```sh
pnpm run dev:api
pnpm run dev:worker
```

Use matching database, queue and VTpass settings in both apps. The worker needs no API authentication settings. See the [worker setup guide](apps/worker/README.md) and [shared backend boundaries](packages/backend/README.md).

`npm run dev:api` and `npm run dev:worker` also run the focused watch tasks. Use pnpm for dependency installation to keep the workspace lockfile consistent.

| Resource                      | Local address                       |
| ----------------------------- | ----------------------------------- |
| Process liveness              | <http://127.0.0.1:4000/health/live> |
| Interactive API documentation | <http://127.0.0.1:4000/docs>        |
| OpenAPI JSON                  | <http://127.0.0.1:4000/docs-json>   |
| PostgreSQL                    | `127.0.0.1:55432`                   |
| Redis cache                   | `127.0.0.1:56379`                   |
| Redis jobs                    | `127.0.0.1:56380`                   |
| Mailpit inbox                 | <http://127.0.0.1:58025>            |
| Mailpit SMTP                  | `127.0.0.1:51025`                   |

The liveness endpoint reports that the API process is responding; it does not check the database, queues, or payment providers. Interactive documentation is disabled in production.

Stop the development applications together with `Ctrl+C`. Stop the local services while preserving their data with:

```sh
docker compose -f compose.api.yaml stop
```

## Development commands

Run commands from the repository root.

| Command                                       | Purpose                                                       |
| --------------------------------------------- | ------------------------------------------------------------- |
| `pnpm run dev:api`                            | Start the API with automatic reload                           |
| `pnpm run dev:worker`                         | Start the standalone worker and watch shared code             |
| `pnpm run build:worker`                       | Build shared backend and worker                               |
| `pnpm --filter @axiapay/worker start`         | Run the compiled standalone worker                            |
| `pnpm --filter @axiapay/backend test`         | Test shared payment, wallet and provider behavior             |
| `npm run dev`                                 | Start API, worker, web and docs with shared-backend watching  |
| `pnpm run build`                              | Build the workspace applications                              |
| `pnpm run lint`                               | Run workspace lint checks                                     |
| `pnpm run check-types`                        | Run workspace TypeScript checks                               |
| `pnpm --filter @axiapay/api format:check`     | Check API formatting                                          |
| `pnpm --filter @axiapay/api test`             | Run configuration and HTTP tests                              |
| `pnpm --filter @axiapay/api test:integration` | Check PostgreSQL and Redis using disposable Docker containers |
| `pnpm run build:api`                          | Build shared backend and API to their own `dist` folders      |
| `pnpm --filter @axiapay/api start`            | Run the compiled API                                          |
| `pnpm --filter @axiapay/api db:migrate`       | Apply migrations after building the API                       |

Integration tests use disposable databases rather than the local development database. API startup never runs migrations automatically. See the [API setup guide](apps/api/README.md) and [migration guide](apps/api/migrations/README.md) for more detail.

See the [authentication guide](apps/api/src/modules/authentication/README.md) for request examples, Mailpit code retrieval, expiry, rate limits, and session behaviour.

## Engineering agreements

Follow [AGENTS.md](AGENTS.md) and the [API architecture guide](apps/api/docs/architecture.md) when contributing. Controllers and job handlers invoke feature services, which coordinate domain rules and repository contracts. Separate use-case classes are optional for complex workflows with a clear independent responsibility. Concrete repositories own storage access directly or coordinate optional data sources when storage complexity or reuse justifies them. Authentication executes SQL in its repository; wallets retain their PostgreSQL data source. Kysely and ioredis stay behind repository contracts, with cache policy and invalidation owned by repositories.

Cache identity must include effective query parameters and authorized account scope. Relevant writes must invalidate affected cached results after commit, with recovery and stale-fill protection defined before caching is implemented. Spending decisions use authoritative database state.

Use clear business names, focused responsibilities, guard clauses instead of nested `if` statements, and concise responsibility documentation. Payment work must preserve exact monetary values, atomic movements, idempotency, and explicit recovery states.

## Product references

- [Individual MVP specification](https://chatgpt.com/space/page_9d42d84b06448191a7129d5deeecb916)
- [Individual MVP user stories](https://chatgpt.com/space/page_f37cd1daa0448191bd9b28617060f66e)
- [Technology stack and application structure](https://chatgpt.com/space/page_d527055d03a88191b1383b8d08883119)

These drafts distinguish confirmed decisions, proposed defaults, and open release questions. A planned feature or acceptance criterion does not imply that it has been implemented.
