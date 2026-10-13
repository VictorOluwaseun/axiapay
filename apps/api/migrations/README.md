# Database migrations

Authentication is introduced by `202610130000-authentication.js`: verified contacts, challenges, sessions, and rate-limit counters. Its tables are separate from wallet and ledger records.

The wallet ledger is introduced by `202610130001-wallet-ledger.js`. Add reviewed timestamp-prefixed `.js` ESM migrations exporting `up(db)` and, when safe and meaningful, `down(db)`. Use Kysely schema operations or SQL. Migration files must remain independent of current domain code.

`202610130002-wallet-funding.js` adds immutable funding bindings, single initialization claims, and unique verified partner payment identities. Its separate `grant_funding_runtime_access('your_runtime_role')` grant allows only the storage operations used by the funding feature. Partner ledger accounts are provisioned administratively; applying the migration does not enable or call a partner. See the [funding configuration guide](../src/modules/wallet-funding/README.md).

After building, `pnpm --filter @axiapay/api db:migrate` applies pending migrations using `DATABASE_URL`. The runner resolves this directory relative to its compiled location. It never runs during API startup and provides no automatic rollback command. `db:types` regenerates infrastructure types after schema changes; review exact monetary mappings.

Wallet history deliberately has no destructive `down` migration. Apply financial schema changes with reviewed forward migrations. Provision a separate runtime database login and call `select grant_wallet_runtime_access('your_runtime_role')` as the migration owner. The API must not own its tables or have permission to disable triggers. System partner/fee accounts require reviewed administrative provisioning.

`pnpm --filter @axiapay/api db:types:test` migrates a disposable PostgreSQL container and regenerates storage types; `db:types:verify` checks for schema drift without writing them. Both require Docker. These commands preserve bigint strings and map PostgreSQL transaction IDs explicitly. They do not use the development database.

`202610130003-device-authentication.js` adds registered public keys, one-use device challenges, and nullable device/primary-authentication provenance on sessions. Existing sessions remain usable but cannot authorize enrollment until fresh password/code authentication. Apply it before deploying the new authentication queries and grant the authentication runtime role access to the new tables. See [device authentication rollout](../src/modules/authentication/device-login.md#persistence-and-rollout).

`202610130005-provider-neutral-funding.js` removes the closed provider enum and adds immutable funding option IDs. It backfills existing history without changing accepted financial terms or receipts. Deploy it before the provider-neutral funding queries; the `partner` columns retain their legacy names but hold generic adapter binding IDs.

`202610130004-service-payments.js` adds immutable airtime/data catalogue revisions and owner/wallet-bound review quotes, durable logical payment identities, single submission claims and append-only correlated outcomes. It seeds no products and enables no adapters. Apply it before deploying payment queries; grant `grant_service_payments_runtime_access('your_runtime_role')` alongside wallet/authentication grants. The runtime role cannot publish or reprice products. See the [payment contract and recovery guide](../src/modules/payments/README.md).

`202610130006-tv-electricity.js` extends the existing catalogue with TV packages and prepaid/postpaid electricity. It adds immutable verified recipients, owner/product-bound bill quote references and separate append-only token/activation/reference receipts. Existing mobile quotes, fingerprints and wallet balances remain unchanged. Apply it before deploying the extended payment queries, then re-run `grant_service_payments_runtime_access('your_runtime_role')` to grant the new table privileges. The migration seeds no billers or adapters and has no destructive rollback.

Migration `202610130007-education-insurance.js` adds immutable education beneficiary evidence, consented eligible individual insurance applications, scoped quote bindings and private issued-document descriptors. Insurance applications accept at most one logical payment across quotes. Existing mobile and bill fingerprints/history and wallet balances remain unchanged; no products or provider adapters are enabled. Re-run `grant_service_payments_runtime_access` after upgrading for the new tables.

Migration `202610130008-bank-transfers.js` adds immutable first-party bank profiles, owner/product-bound verified recipients, bank quote/narration bindings, safe failure reasons and deferred atomic recipient-credit proof protection. Original mobile/bill/insurance history, fingerprints and wallet balances remain unchanged. Re-run `grant_service_payments_runtime_access` after upgrading. It publishes no bank, product, price or adapter.
