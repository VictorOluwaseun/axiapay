# Existing-account wallet backfill

Verified signup creates its account, NGN wallet, two liability accounts and session atomically. Accounts registered before that behavior need an explicit backfill; login does not create wallets.

After building the API, run `pnpm --filter @axiapay/api auth:backfill-wallets` against the intended `DATABASE_URL`. The equivalent command from `apps/api` is `node --env-file-if-exists=.env dist/infrastructure/database/backfill-verified-wallets.js`. The command never runs during API startup. It requires authentication-account SELECT/row-lock privileges plus the existing wallet-provisioning grants. Use the reviewed migrations and take a database backup before an operational run.

`VerifiedWalletBackfillService` pages through verified account IDs in batches of 100 and applies the signup currency policy. `PostgresAccountWalletProvisioningRepository` locks and rechecks each account, then binds the existing wallet repository/data source to that account's transaction. A removed account is skipped. Disabled verified accounts retain the same wallet entitlement as an account disabled after signup; provisioning does not restore login or spending access.

Each account commits independently. If provisioning fails, that account's wallet and ledger accounts roll back together; earlier completed accounts remain committed. Re-running the same command safely revisits them. Concurrent runs and signup provisioning share the wallet's owner/currency uniqueness rule. Existing wallet IDs, frozen/closed status, balances, other currencies and financial history remain unchanged. Newly created wallets have zero balances; no journals, reservations, payments, fees or external provider calls are produced.

The result reports `processedAccounts`, meaning verified accounts whose wallet was ensured, including wallets that already existed. It does not report that every processed account received a new wallet. The command logs counts/error categories only, without contacts, tokens or credentials.

Verify no eligible account is missing NGN, each new wallet has its two liability accounts and zero balances, and a second run preserves IDs/counts. Integration tests cover paging, funded/frozen wallet preservation, concurrent independent pools and interruption/retry.
