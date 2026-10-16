# Wallets

AxiaPay owns the customer subledger. It implements empty-wallet provisioning, owner-authorized balances, confirmed funding collections, internal transfers, reservations, and full reservation capture/release. It uses the existing PostgreSQL/Kysely stack and installs no new dependency.

Successful signup verification provisions the user's empty NGN wallet automatically in the same transaction as account activation and session issuance. `POST /v1/wallets` returns that wallet for NGN and can create a wallet for another currency. Login does not backfill wallets for older accounts. The existing owner/currency uniqueness constraint prevents duplicates, including concurrent calls. Provisioning an internal wallet does not create a provider bank account or credit money.

## Calling the module

`WalletModule` exports `WalletService` through Nest dependency injection for customer operations. `WalletModule.register({ funding, paymentOutcome })` additionally registers trusted verifier adapters for integration callers. Calling funding or settlement without the corresponding verifier fails with `VERIFICATION_UNAVAILABLE` before touching the ledger; there are no permissive defaults. The service owns wallet operations through transaction-bound repositories and delegates the held-money lifecycle to `WalletReservationService`. `DatabaseModule` manages the shared pool lifecycle. API and worker callers share these operations.

| Use case                  | Guarantee                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CreateWallet`            | One wallet per authenticated owner/currency, created with both accounts atomically.                                                              |
| `GetWalletBalance`        | Current database snapshot, restricted to the owner.                                                                                              |
| `ConfirmWalletFunding`    | Credits only evidence accepted by a required funding verifier; one credit per partner account and external movement.                             |
| `TransferBetweenWallets`  | Atomic same-currency movement between active wallets, with ownership and available-funds checks.                                                 |
| `ReserveWalletFunds`      | Moves the accepted payment's full debit from available to reserved, linked to a durable payment reference.                                       |
| `SettleWalletReservation` | Full capture on verified success or full release on verified failure with no outstanding partner debit. Unknown outcomes retain the reservation. |

`WalletHttpModule`, imported by `ApiModule`, exposes authenticated wallet creation, owner/currency discovery, balances, and internal transfers through the shared `WalletService`. It obtains `actorId` exclusively from the verified session, rejects unknown DTO fields, and maps domain bigints to integer strings in JSON. Never accept an actor identity, settled-funding object, or provider-success flag directly from a customer request. Wallet ownership is checked again inside customer service operations. Funding and settlement are trusted integration operations, not customer mutation endpoints. Reservations remain behind the [accepted-payment workflows](../payments/README.md), which own quote consent, fees, product limits and provider execution. Service-provider adapters remain unconnected by default.

The base module has no permissive verifier defaults. The [wallet-funding feature](../wallet-funding/README.md) supplies provider-neutral collection verification through `WalletModule.withFundingVerification`. Optional delivery adapters authenticate notifications; the funding core independently verifies payment status and financial terms, binds the payment to an existing funding request, and records a unique economic movement before invoking this ledger. Its partner account is gross collection clearing; bank settlement and fee/reversal accounting are separate. The [payment feature](../payments/README.md) supplies trusted stored-outcome verification through `WalletModule.withPaymentOutcomeVerification`; accepted references, exact principal/fee allocation and safe failure evidence precede capture/release. Bank success additionally requires matching receiving-account credit proof. Payment instruction/quote records and provider attempts belong to the payments feature, whose external execution adapters remain unregistered by default.

## Customer HTTP API

Every route requires `Authorization: Bearer <accessToken>` from successful signup verification or login. Protected mutations check current session/account state in PostgreSQL; read-only authentication may use the [signed identity cache](../authentication/session-cache.md). Authoritative balance-by-ID and spending checks read PostgreSQL. The shared `WalletService.getWalletByOwner` retrieves the owner/currency display summary through a repository contract; API composition supplies the cache described below. The controller never accepts an owner override. UUID case is normalized before service calls and idempotency fingerprints. Existing verified users can receive their initial NGN wallet through the explicit [wallet backfill command](../authentication/wallet-backfill.md).

| Method | Route                             | Input                                              | Success                                                                     |
| ------ | --------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------- |
| POST   | `/v1/wallets`                     | `{ "currency": "NGN" }`                            | 201: empty wallet or existing owner/currency wallet with current balances   |
| GET    | `/v1/wallets/me?currency=NGN`     | Required uppercase three-letter currency query     | 200: caller’s cached display summary; 404 if absent; never creates a wallet |
| GET    | `/v1/wallets/:walletId/balance`   | Wallet UUID in the path                            | 200: owner-only authoritative balance                                       |
| POST   | `/v1/wallets/:walletId/transfers` | Destination, currency, amount, logical request key | 200: committed operation receipt, including on replay                       |

Wallet creation and balance responses have this shape:

```json
{
  "id": "c764f366-e737-4c84-b63b-0df02ad39c76",
  "currency": "NGN",
  "walletStatus": "active",
  "availableMinorUnits": "12500",
  "reservedMinorUnits": "2500",
  "totalMinorUnits": "15000"
}
```

Internal transfer body:

```json
{
  "destinationWalletId": "27e8e98c-caae-40d2-8d45-06c15ef7de66",
  "currency": "NGN",
  "amountMinorUnits": "5000",
  "requestKey": "transfer-0192d5ca-7c24-7f32-9c93-c755ff393782"
}
```

The source is the owned wallet in the path. Amounts must be canonical positive integer strings, at most `9223372036854775807`; numbers, decimal fractions, exponents, signs, whitespace, and leading zeros are rejected. Internal transfers currently move exactly this amount with no extra fee. Currency syntax is validated as three uppercase letters; a supported-currency catalogue is not implemented.

The response is `{ "operationId": "<uuid>" }`. Persist the request key before submitting and reuse it with identical terms after a timeout or 503. Changed terms with the same owner-scoped key return 409 `IDEMPOTENCY_CONFLICT`. A committed replay succeeds even if subsequent wallet spending changes the balance. Client requests must never treat a 503 as proof that no transfer happened or automatically retry with a new key.

Validation errors return 400. Wallets that do not exist or are not owned by the caller return the same 404. Insufficient funds, restricted wallets, currency mismatches, and conflicting request keys return 409 with explicit codes. Dependency failures return a redacted 503. Errors use the shared `{ statusCode, code, message, requestId }` envelope; see [HTTP error handling](../../../docs/error-handling.md). Success and handled failure responses disable caching. Development OpenAPI at `/docs` describes these contracts. DTO validation uses the existing [Nest ValidationPipe](https://docs.nestjs.com/techniques/validation) configuration with implicit conversion disabled and unknown fields rejected.

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

Financial reads and the balance-by-ID endpoint require immediate consistency and bypass Redis. `GET /v1/wallets/me?currency=NGN` reads an existing owner/currency wallet through a separate, repository-owned display cache. It returns the same public wallet shape with exact string amounts and no internal ledger identities. It never provisions a wallet and does not cache missing results. See [wallet summary caching](wallet-summary-cache.md) for expiry, committed invalidation, recovery and consistency limits. The outbox durably records journal notifications, but a dispatcher and external partner reconciliation are not implemented. A future consumer must tolerate repeated delivery and must not treat an outbox record as provider execution evidence.

The generated database types reflect migrated PostgreSQL tables. `pg` bigint columns arrive as strings and are converted to domain bigints inside the repository. Never change global driver parsers to JavaScript numbers for money.

## Validation

Unit tests cover exact amounts and journal invariants. Disposable PostgreSQL integration tests exercise service operations through a restricted runtime role: simultaneous creation, duplicate funding and reservations, conflicting request reuse, concurrent spending, ownership, currencies, frozen wallets, verified capture and safe release, uncertain outcomes, rollback, direct SQL violations, immutable history, and projection/reservation reconciliation.

HTTP integration tests exercise the real authentication guard and signup/session lifecycle alongside that restricted ledger role: owner binding, all session rejection states, cross-account access, hostile DTOs, exact large balances, concurrent transfers and replays, currency and wallet restrictions, redacted uncertain outcomes, and safe retries. No guard is mocked and no balance is changed directly by fixtures.

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
