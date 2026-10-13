# Wallets

AxiaPay owns the customer subledger. This first increment implements empty-wallet provisioning, owner-authorized balances, settled funding, internal transfers, reservations, and full reservation capture/release. It uses the existing PostgreSQL/Kysely stack and installs no new dependency.

## Calling the module

`WalletModule.register({ funding, paymentOutcome })` registers explicit verifier adapters and exports `WalletService` through Nest dependency injection. The service owns wallet operations through transaction-bound repositories and delegates the held-money lifecycle to `WalletReservationService`. `DatabaseModule` manages the shared pool lifecycle. API and worker callers share these operations.

| Use case                  | Guarantee                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CreateWallet`            | One wallet per authenticated owner/currency, created with both accounts atomically.                                                              |
| `GetWalletBalance`        | Current database snapshot, restricted to the owner.                                                                                              |
| `ConfirmWalletFunding`    | Credits only evidence accepted by a required funding verifier; one credit per partner account and external movement.                             |
| `TransferBetweenWallets`  | Atomic same-currency movement between active wallets, with ownership and available-funds checks.                                                 |
| `ReserveWalletFunds`      | Moves the accepted payment's full debit from available to reserved, linked to a durable payment reference.                                       |
| `SettleWalletReservation` | Full capture on verified success or full release on verified failure with no outstanding partner debit. Unknown outcomes retain the reservation. |

There are no wallet HTTP routes yet. A controller or worker must obtain `actorId` from a verified session, enforce the payment authorization/quote/limit rules for its business action, and map domain bigints to integer strings in JSON. Never accept an actor identity, settled-funding object, or provider-success flag directly from a customer request. Wallet ownership is checked again inside customer service operations. Funding and settlement are trusted integration operations, not customer mutation endpoints.

The verifier ports have no default implementation. A real funding adapter must authenticate the source, verify the settled economic movement, bind it to the intended wallet and provisioned partner asset account, and return canonical amounts/currency. The outcome adapter must verify the accepted payment reference, final outcome, actual principal deduction, and authorized fee allocation. Payment instruction/quote records and provider attempts belong to the payments integration; the wallet module does not implement them.

## Ledger and reservations

Each wallet has `wallet_available` and `wallet_reserved` liability accounts. Their credit-minus-debit balances are the available and reserved values. Total customer funds are their sum; reservations are not subtracted from available again. Pending funding and pending refunds do not create spendable funds.

A wallet operation is one financial action, with exactly one immutable journal and one outbox event. A payment can own several operations: reserve, then capture or release. `paymentReference`, wallet operation ID, provider evidence reference, and transport request key are different identities.

Reservations currently resolve in full. Capture can split the reserved debit between partner principal and AxiaPay fee income. Partial capture, partial release, refunds, chargebacks, partner receivables, and in-transit accounting are later increments. The current success posting is valid only when the verifier establishes the partner deduction and final delivery; it must not be reused to model an earlier partner debit. The fee allocation must come from accepted server payment terms, not arbitrary provider or client input.

Money uses positive bigint minor units with a currency identifier. Currency syntax is validated, but the supported-currency/product catalogue remains a caller policy. No foreign exchange or currency conversion is implemented. Fee rounding occurs before the wallet services receive accepted terms.

## Transactions and replay

The application expresses one atomic boundary through `WalletRepository.executeOnce`. Infrastructure binds all callback operations to the same Kysely transaction. Claim, reservation, journal, projection changes, and outbox insertion commit or roll back together. Provider verification happens before opening the transaction; transaction callbacks make no network calls.

Customer request keys are scoped to the authenticated owner. Funding keys use the partner account and stable external movement ID, not a webhook delivery ID. Reservation resolution uses one permanent key per reservation. Canonical fingerprints contain financial inputs and action kind; reuse with changed terms conflicts. Retrying the same identity returns the original immutable receipt. Claims are retained with financial history.

Wallet rows are locked in UUID order, followed by their balances. Resolution locks its reservation before its wallet. Shared system accounts are locked after customer accounts, in UUID order. New writers must preserve this order. Only PostgreSQL-confirmed serialization failures and deadlocks are retried, at most three attempts. Connection errors with an uncertain commit are surfaced; the caller can reconcile/retry using the original request identity.

Frozen wallets reject new reservations/transfers but can receive verified funding. Previously authorized reservations can settle after a freeze. Closed wallets reject new funding; previously accepted obligations still resolve. Production closure must require zero balances and no unresolved obligations through its own future workflow.

## Database protection and operations

The migration enforces currency-matched foreign keys, balanced journals, positive amounts, nonnegative customer balances, immutable history and identities, one reservation resolution, and reservation-to-ledger consistency. Entries cannot be appended to a committed journal. Only entry projection triggers change balances. Orphaned wallet operations and incomplete wallet provisioning fail at commit.

Runtime permissions must be separate from the migration owner. After provisioning the runtime login, the migration owner calls `select grant_wallet_runtime_access('your_runtime_role')`. This grants the privileges exercised by integration tests, including narrowly granted column updates needed for row locks. Do not grant schema creation, table ownership, trigger-disabling rights, or unrestricted table updates to the application. The migration owner can deliberately bypass protections and is an administrative trust boundary. System accounts are provisioned through reviewed administrative migrations; no customer account-provisioning endpoint exists for them.

Wallet reads require immediate consistency and bypass Redis. No wallet cache entries exist to invalidate. The outbox durably records journal notifications, but a dispatcher and external partner reconciliation are not implemented. A future consumer must tolerate repeated delivery and must not treat an outbox record as provider execution evidence.

The generated database types reflect migrated PostgreSQL tables. `pg` bigint columns arrive as strings and are converted to domain bigints inside the repository. Never change global driver parsers to JavaScript numbers for money.

## Validation

Unit tests cover exact amounts and journal invariants. Disposable PostgreSQL integration tests exercise service operations through a restricted runtime role: simultaneous creation, duplicate funding and reservations, conflicting request reuse, concurrent spending, ownership, currencies, frozen wallets, verified capture and safe release, uncertain outcomes, rollback, direct SQL violations, immutable history, and projection/reservation reconciliation.

From the workspace root:

```sh
pnpm --filter @axiapay/api test
pnpm --filter @axiapay/api test:integration
pnpm --filter @axiapay/api check-types
pnpm --filter @axiapay/api lint
pnpm --filter @axiapay/api build
pnpm --filter @axiapay/api db:types:verify
```

Integration and schema-verification commands require Docker and use disposable databases. They do not migrate development data. See [the ledger decision](../../../docs/decisions/0002-wallet-ledger.md).
