# AxiaPay wallet funding

AxiaPay owns funding requests, authenticated APIs, business rules, duplicate protection and ledger posting. External systems implement a narrow adapter contract. OPay and Paystack are retained in [adapters](adapters/README.md); neither is required by the domain, workflows, customer DTOs or core module.

## Customer API contract

All customer routes require an opaque bearer session and enforce wallet/request ownership in the business workflow. Amounts are canonical positive integer strings in minor units. Payer email is receipt information, never authorization.

| Method | Route                                     | Result                                                                                                          |
| ------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/wallets/:walletId/funding-options`   | Available AxiaPay option IDs, names, currency and exact minimum/maximum amounts. Empty when none is configured. |
| POST   | `/v1/wallets/:walletId/funding-requests`  | 202: durable request, with checkout URL once available.                                                         |
| GET    | `/v1/wallet-funding/:fundingId`           | Owner-authorized pending/credited state.                                                                        |
| POST   | `/v1/wallet-funding/:fundingId/reconcile` | Independent verification and idempotent credit; 409 while unconfirmed.                                          |

Discover options for the wallet, then submit an option ID from that response:

```json
{
  "fundingOptionId": "hosted-checkout",
  "currency": "NGN",
  "amountMinorUnits": "100000",
  "payerEmail": "customer@example.com",
  "requestKey": "funding-0192d5ca-7c24-7f32-9c93-c755ff393782"
}
```

`hosted-checkout` is illustrative; available IDs come from server composition. Clients never send a provider name, clearing account, environment, callback URL, owner ID or success flag. Unknown fields are rejected. Discovery is filtered by wallet currency, and the authoritative workflow checks the selected option's limits again. Technical adapter limits do not replace future approved product/identity limits.

The response includes `fundingId`, `walletId`, `fundingOptionId`, `environment`, `currency`, `amountMinorUnits`, `fundingStatus`, `checkoutUrl` and `operationId`. URLs and operation IDs may be null. Adapter and clearing account identities are private. `credited` requires a matching committed ledger receipt. Checkout creation and browser redirects never make money spendable; all unresolved states remain `pending`. Responses disable caching. DTO-generated OpenAPI is available at `/docs` in development.

| Error                                       | Meaning                                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `INVALID_INPUT` / `INVALID_FUNDING`         | Malformed customer terms, unsupported amount, unsafe checkout URL or mismatched verification. |
| `INVALID_CREDENTIALS`                       | Missing, expired, revoked or otherwise invalid session.                                       |
| `WALLET_NOT_FOUND` / `FUNDING_NOT_FOUND`    | Missing or inaccessible resource; no ownership disclosure.                                    |
| `FUNDING_CONFLICT` / `IDEMPOTENCY_CONFLICT` | Same logical request/payment identity with different terms.                                   |
| `FUNDING_UNCONFIRMED`                       | No independently confirmed successful collection; no credit.                                  |
| `FUNDING_UNAVAILABLE`                       | No configured option/binding or dependency uncertainty; retain the original request key.      |

## Adapter boundaries and composition

- `FundingAdapter.initialize` receives only a persisted merchant reference, exact money and payer email, and returns a validated HTTPS checkout URL. Wallet identity and customer idempotency keys never cross this boundary.
- `FundingAdapter.verify` independently queries using server credentials and returns canonical reference, economic movement ID, exact money and success. It cannot post ledger entries or select the credited wallet.
- The provider's delivery adapter authenticates raw callbacks according to its protocol, then calls `WalletFundingService.receiveNotification` with a canonical identity scoped to the authenticating adapter/account/environment. No generic unauthenticated notification HTTP endpoint exists.
- Repositories own SQL and concurrency constraints. The funding and wallet services own authorization, state transitions, exact-term matching and credit decisions. Financial reads bypass caches.

`WalletFundingModule.register()` runs with no adapters: authenticated API routes still exist, discovery returns an empty list, and external funding fails closed. There is no production mock-credit switch. The independent adapter used by core tests exists only in the test tree.

Supply explicit dependency injection bindings when an integration is ready:

```ts
WalletFundingModule.register({
  imports: [YourAdapterModule],
  routes: { useExisting: YOUR_FUNDING_ROUTES },
});
```

The exported token resolves to `readonly FundingRoute[]`, each with an AxiaPay option, stable `adapterId`, `acceptsNewRequests` flag and `FundingAdapter`. See [port contracts](ports/funding-adapter.ts). IDs are lowercase slugs of at most 64 characters. Registration rejects duplicate option IDs, one adapter ID bound to multiple accounts/environments, reused clearing accounts across adapters, and invalid limits.

An adapter ID identifies a merchant integration, not merely a vendor. Keep it stable for that account/environment. To retire an option, set `acceptsNewRequests: false` while retaining its original binding for reconciliation. Accepted requests retain their immutable binding; changing the route for new requests never changes past intent. If the original binding is absent, verification fails closed. Replaying an already submitted request still returns its original identity, even after its option is withdrawn.

## Persistence and financial guarantees

1. Immutable request terms bind owner, wallet, option, adapter, environment, clearing account, currency, amount and receipt email before external submission. The funding UUID is the merchant reference.
2. `(owner_id, request_key)` uniqueness and a durable single initialization claim prevent concurrent retries from creating multiple orders. Reusing a key with changed terms conflicts; routing changes do not reinterpret original terms.
3. Independent verification must match reference, amount, currency and successful state. A notification additionally binds the exact movement ID. IDs are opaque strings; callback delivery IDs/timestamps never replace economic payment identity.
4. `wallet_funding_payments` uniquely binds a movement to one request and a request to one movement. The legacy `partner` SQL column now contains a generic adapter binding ID; its closed provider enum has been removed. The ledger independently deduplicates by clearing account and movement, rejecting changed wallet/amount terms.
5. Verification receipt persistence precedes the atomic ledger transaction. A crash between stages leaves recoverable pending work. Notifications acknowledge only after commit or a matching committed replay. A committed duplicate can be acknowledged during a later adapter outage.
6. Ledger journal, balanced entries, balance projections and outbox are committed atomically by `WalletService`; external calls occur outside transactions. The immutable journal is the source of credited state.

The clearing-account guard serializes initial bindings and prevents an account being reused across adapters/environments. Runtime database connections cannot own tables, disable guards or rewrite financial history. Use separate test/live databases and administratively provisioned `partner_funds` accounts. Runtime grants are documented in [migration responsibilities](../../../migrations/README.md).

## Recovery and rollout

Persist the request key before submission and reuse it after a timeout/503. If initialization was accepted externally but its response was lost, retries return the same funding identity with a null URL; they never create another order. Reconcile that identity and resolve the external order before considering a replacement. Automatic checkout-URL recovery and scheduled reconciliation are not implemented.

An authenticated notification with unconfirmed/mismatched verification receives a non-2xx response and creates no credit. Unknown authenticated references are ignored because an external merchant may serve other products. A verified collection blocked by a closed wallet remains pending for operational repair and replay. GET remains read-only.

The draft API's `partner` field has been replaced with `fundingOptionId`; clients must adopt discovery before rollout. Forward migration `202610130005-provider-neutral-funding.js` adds option identity, backfills existing requests as `<previous-partner>-checkout`, and removes the hard-coded provider constraint. It preserves all existing financial terms, initialization claims, fingerprints and verified receipts; old request keys remain replayable. Drain older funding writers, apply the migration, then deploy the new repository queries; older code cannot insert requests without the new required option ID. No development database is migrated automatically.

## Scope and validation

Funding credits the exact requested amount on verified collection. The partner asset is gross collection clearing, not proof of bank settlement or the partner's withdrawable balance. Fees, payouts, refunds, chargebacks and settlement reconciliation require their own accounting workflows. Later refunds do not currently reverse a credited deposit. No undisclosed fee is deducted from requested funding.

Core tests use the actual HTTP session guard, restricted PostgreSQL role, migration chain and ledger, with an independent test adapter and with no adapters. They exercise discovery, limits, authorization, concurrent retries, notification binding, duplicate payments, exact verification, uncertain outcomes, adapter changes and withdrawn options. Upgrade tests preserve pre-existing funding history. Separate retained-adapter tests cover provider signatures and wire formats without live merchant calls.
