# Shared backend

`@axiapay/backend` contains payment, wallet and service-catalogue domain rules, contracts, services, repositories, provider adapters, and their Nest composition. API and worker are separate application leaves that depend on this library. The library never imports either app and contains no HTTP controllers or BullMQ consumers.

`PaymentsRuntimeModule` composes the same financial workflows and evidence-backed ledger verification for both apps. Concrete repositories remain private Nest providers; services use repository and capability contracts. Provider calls remain outside database transactions. This move preserves the existing financial behavior and does not add integrations or demo fallbacks.

The package owns the Kysely connection factory, generated database schema, shared HTTP transport policy and non-HTTP input-validation wrapper. Reviewed migrations and migration/type-generation commands remain in `apps/api`; generated types are written here. `tests/support` provides test-only fixtures used by both apps, excluded from build output and public exports.

```sh
pnpm --filter @axiapay/backend build
pnpm --filter @axiapay/backend test
pnpm --filter @axiapay/backend lint
pnpm --filter @axiapay/backend check-types
```

Use root `build:api` / `build:worker` commands to compile dependencies before each app. Root `dev:api` / `dev:worker` use Turbo watch so shared changes rebuild and restart the affected application. Production exports resolve compiled JavaScript and declarations in `dist`, not TypeScript source.
