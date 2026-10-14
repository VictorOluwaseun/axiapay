# AxiaPay API

NestJS and Fastify foundation for individual payments. Active routes include verified phone/email authentication, authenticated wallet creation, balances and internal transfers, process liveness, and development OpenAPI documentation. See the [authentication guide](src/modules/authentication/README.md) for password and one-time-code flows and the [wallet HTTP contract](src/modules/wallets/README.md#customer-http-api).

The [first-party service payment APIs](src/modules/payments/README.md) now provide product discovery, service and bank-recipient verification, insurance consent/eligibility, exact review quotes, duplicate-safe wallet-backed submission, request-key recovery and delayed token/policy/document reconciliation. Fulfilment uses injected adapter contracts; `PaymentsModule.register()` has no adapter or commercial product by default and cannot reserve money for an unavailable integration.

## Local setup

Use Node.js 24.15 or newer within the 24.x release line and the workspace's pinned pnpm version. From the repository root:

```sh
pnpm install --frozen-lockfile
docker compose -f compose.api.yaml up -d --wait
cp -n apps/api/.env.example apps/api/.env
pnpm --filter @axiapay/api auth:setup
pnpm --filter @axiapay/api build
pnpm --filter @axiapay/api db:migrate
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

`docker compose -f compose.api.yaml stop` stops this project's services without deleting data. Application liveness does not assert data-source readiness. Authentication uses local Mailpit capture for email and simulated SMS. Wallet funding exposes AxiaPay-owned option discovery, request and reconciliation contracts. OPay and Paystack are retained as optional adapters; see the [funding contracts and recovery guide](src/modules/wallet-funding/README.md). Production message delivery, partner payout, and settlement/reversal accounting remain separate work.

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

Checks cover configuration, HTTP routing, credential rules, PostgreSQL and Redis compatibility, and authentication failure and concurrency paths. Mailpit integration tests verify local email and simulated SMS capture. Feature guides describe their additional test coverage.

The API has its own Turborepo configuration for build outputs and runtime environment variables. Existing web and documentation applications keep their own configuration.

## Layout and dependencies

See [architecture](docs/architecture.md), [stack practices](docs/stack-practices.md), [the foundation decision](docs/decisions/0001-api-foundation.md), and each feature's README. `package.json` records exact versions. Kysely/pg provide SQL access; ioredis provides cache connectivity; BullMQ is available for future workers. Class-validator/class-transformer DTOs validate HTTP requests through Nest pipes; Config/Zod validate settings; Pino supplies redacted diagnostics; Argon2id protects passwords; authentication uses revocable opaque sessions and keyed code digests. A validated configuration never logs invalid supplied values.

Migrations are explicit: after building, run `pnpm --filter @axiapay/api db:migrate`. See [migration responsibilities](migrations/README.md). The wallet migration defines the customer subledger, reservations, idempotency records, and outbox; the funding migration adds immutable funding requests and verified payment identities. `WalletHttpModule` connects authenticated customer routes to `WalletService`; `WalletFundingModule.register()` composes provider-neutral funding with no adapters by default. The bootstrap integration module optionally supplies retained OPay/Paystack adapters and their authenticated callbacks. Generate database types with `db:types` after reviewed schema changes.

## Wallet implementation

See [wallet contracts, guarantees, and remaining integrations](src/modules/wallets/README.md) and [the ledger decision](docs/decisions/0002-wallet-ledger.md). Integration tests use a restricted runtime database role and disposable PostgreSQL instances. `pnpm --filter @axiapay/api db:types:verify` checks generated types against the migration chain in a disposable container.

## Fingerprint login API

Verified accounts can enroll device public keys and exchange signed challenges for the existing bearer sessions. The API includes active-device listing and revocation. See [the integration contract](src/modules/authentication/device-login.md) for endpoints, Android signing requirements, freshness and expiry rules, recovery, and migration rollout. This implements key-possession verification; the Android biometric prompt and hardware attestation are not implemented here.

The [bank transfer contracts](src/modules/payments/bank-transfers.md) provide a first-party bank directory, beneficiary verification, exact quotes, duplicate-safe transfer submission and recovery with separate bank/funds states. Actual receiving-account credit is mandatory before bank success can settle the wallet. Banks, fees, limits and provider adapters are not seeded or connected.

The [airtime conversion contracts](src/modules/airtime-conversion/README.md) provide source eligibility, exact gross/fee/net quotes, explicit acceptance, fixed transfer instructions, receipt exceptions and duplicate-safe inbound wallet credit. Saved verified proof supports credit recovery after adapter removal. The bootstrap registers no conversion adapter, eligible network, rate or fee.
