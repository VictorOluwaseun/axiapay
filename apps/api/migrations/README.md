# Database migrations

Authentication is introduced by `202610130000-authentication.js`: verified contacts, challenges, sessions, and rate-limit counters. Its tables are separate from wallet and ledger records.

The wallet ledger is introduced by `202610130001-wallet-ledger.js`. Add reviewed timestamp-prefixed `.js` ESM migrations exporting `up(db)` and, when safe and meaningful, `down(db)`. Use Kysely schema operations or SQL. Migration files must remain independent of current domain code.

After building, `pnpm --filter @axiapay/api db:migrate` applies pending migrations using `DATABASE_URL`. The runner resolves this directory relative to its compiled location. It never runs during API startup and provides no automatic rollback command. `db:types` regenerates infrastructure types after schema changes; review exact monetary mappings.

Wallet history deliberately has no destructive `down` migration. Apply financial schema changes with reviewed forward migrations. Provision a separate runtime database login and call `select grant_wallet_runtime_access('your_runtime_role')` as the migration owner. The API must not own its tables or have permission to disable triggers. System partner/fee accounts require reviewed administrative provisioning.

`pnpm --filter @axiapay/api db:types:test` migrates a disposable PostgreSQL container and regenerates storage types; `db:types:verify` checks for schema drift without writing them. Both require Docker. These commands preserve bigint strings and map PostgreSQL transaction IDs explicitly. They do not use the development database.
