# AxiaPay worker

A separately runnable Nest application for durable background work. It creates an application context with no HTTP listener or API controllers. `PaymentRecoveryWorker` owns BullMQ scheduling and Redis connections; jobs validate their payloads before invoking shared payment services from `@axiapay/payments-runtime`.

## Run locally

From the repository root, after installing dependencies and applying API migrations:

```sh
cp -n apps/worker/.env.example apps/worker/.env
pnpm run dev:worker
```

Set the worker's database, queue Redis and optional VTpass settings to match the API environment and ledger accounts. Use dedicated runtime credentials in deployments and grant both `grant_service_payments_runtime_access` and `grant_payment_recovery_runtime_access`, plus wallet permissions. Do not copy API authentication or funding secrets. Recovery is enabled by default; set `PAYMENT_RECOVERY_ENABLED=false` to disable consumption.

For compiled execution:

```sh
pnpm run build:worker
pnpm --filter @axiapay/worker start
```

The API and worker can start, stop and scale separately. `SIGINT` and `SIGTERM` drain active jobs before queue connections and the database pool close. Payments runtime changes rebuild through Turbo and restart the affected development processes.

## Checks and operations

```sh
pnpm exec turbo run check-types lint test --filter=@axiapay/worker --filter=@axiapay/payments-runtime
pnpm exec turbo run test:integration --filter=@axiapay/worker
pnpm --filter @axiapay/worker payments:retry-recovery <payment-uuid>
```

Worker integration tests require Docker and a compiled worker (`pnpm run build:worker` when invoking Vitest directly). They use disposable PostgreSQL/Redis and check scheduling, invalid payloads, queue outages, restart after data loss, the compiled independent process and graceful termination. The worker package owns the operator retry CLI; it never boots the API.

See [payment recovery](docs/payment-recovery.md) for durable handoff, leases, uncertain outcomes and manual review. This application currently runs recovery only; bulk creation, recurring payments and notifications are not implemented by this split.
