# Optional funding adapters

OPay and Paystack are retained as optional implementations of AxiaPay's [funding contract](../ports/funding-adapter.ts). They remain disabled without complete configuration. The core never imports this directory. `bootstrap/funding-integration.module.ts` connects `ProviderFundingModule` to `WalletFundingModule.register(...)` and installs the provider-specific webhook controller.

The adapter module currently advertises `opay-checkout` and `paystack-checkout` options in NGN. These are deployment-configured IDs, not an API or domain enum. Numeric encoding limits live here: OPay's maximum is the safe integer bound; Paystack sends the amount as a string. These are transport limits, not approved customer or identity limits.

## Inbound and outbound protocols

| Route                                       | Authentication and verification                                                                                                                           |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/webhooks/wallet-funding/paystack` | HMAC-SHA512 over exact raw bytes using the secret; verify successful transaction, reference, amount, currency, ID and reported environment independently. |
| `POST /v1/webhooks/wallet-funding/opay`     | HMAC-SHA3-512 over the documented callback fields including refund flag; independently query status with HMAC-SHA512 and reject voided orders.            |

The delivery controller authenticates raw evidence and passes only a canonical, account-scoped notification to `WalletFundingService.receiveNotification`. A verified callback alone cannot post funds. The outbound adapters query the external system; the core applies exact terms and ledger invariants. HTTP 200 acknowledges committed credit, an identical committed replay, or an authenticated unrelated event. Unsigned/invalid callbacks are rejected before verification.

Provider requests use fixed hosts, eight-second deadlines and no redirects. Checkout URLs are checked against provider host allowlists. Large numeric JSON IDs are preserved exactly. Errors and diagnostics exclude raw responses, signatures, credentials and payer details.

## Configure and run

Apply the new migration with the existing explicit build/migration workflow. Use a migration owner to create a distinct `partner_funds` ledger account for each partner and environment; keep test and live databases separate. The first persisted request binds its clearing account to that partner/environment; an advisory transaction lock and trigger reject conflicting bindings even during concurrent initialization. For example, run the following with reviewed account codes in a development database:

```sql
insert into ledger_accounts (id, account_code, currency, account_kind, wallet_id)
values (gen_random_uuid(), 'funding:paystack:test', 'NGN', 'partner_funds', null)
returning id;

insert into ledger_accounts (id, account_code, currency, account_kind, wallet_id)
values (gen_random_uuid(), 'funding:opay:test', 'NGN', 'partner_funds', null)
returning id;

select grant_wallet_runtime_access('your_runtime_role');
select grant_funding_runtime_access('your_runtime_role');
```

Use the returned IDs in the corresponding settings below. Authentication requires its existing runtime privileges as well. Runtime connections must not own tables or be able to disable triggers.

| Setting                               | Purpose                                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `FUNDING_ENVIRONMENT`                 | `test` by default; explicit `live` configuration uses live partner endpoints/credentials |
| `FUNDING_RETURN_URL`                  | Trusted HTTPS application return page; the page does not prove payment                   |
| `PAYSTACK_SECRET_KEY`                 | Secret with the matching `sk_test_` or `sk_live_` prefix                                 |
| `PAYSTACK_LEDGER_ACCOUNT_ID`          | Provisioned NGN Paystack asset account UUID                                              |
| `OPAY_MERCHANT_ID`                    | Nigeria merchant identity                                                                |
| `OPAY_PUBLIC_KEY` / `OPAY_SECRET_KEY` | Environment-specific checkout and signing credentials                                    |
| `OPAY_LEDGER_ACCOUNT_ID`              | Separate provisioned NGN OPay asset account UUID                                         |
| `OPAY_WEBHOOK_URL`                    | Public HTTPS URL ending in `/v1/webhooks/wallet-funding/opay`                            |

Configure Paystack's webhook URL in its dashboard as the public `/v1/webhooks/wallet-funding/paystack` URL. OPay receives the configured callback URL during checkout creation. Never put secret keys in Android, browser code, fixtures for live accounts, or committed environment files. Partial configuration is rejected, and missing configuration fails closed. The existing production authentication delivery gate remains unchanged.

## Accounting boundary and remaining integrations

This increment credits the exact requested amount on a verified successful collection. The partner asset posting is gross collection clearing; it does not assert bank settlement or equal the partner's currently withdrawable balance. Partner fees, net settlement, payouts, chargebacks and refunds require their own reconciled accounting workflows. No undisclosed fee is deducted from the customer's requested funding amount. Pending/failed/refunded notifications do not create credits; this feature does not automatically reverse an already credited deposit. Those later events require operational reconciliation until reversal handling is implemented.

OPay uses the Nigeria documentation and `testapi`/`liveapi` hosts, not the similarly named Egypt endpoints. Account capabilities and partner acceptance tests must be confirmed using the actual merchant's sandbox credentials before deployment. The code has been exercised with real signatures, actual PostgreSQL transactions, and deterministic HTTP fixtures, not a live merchant account.

## Validation and protocol references

Tests cover published OPay signature vectors, raw Paystack bytes, lossless integers, authorization, concurrent initialization, concurrent callbacks/reconciliation, conflicting terms, forged callbacks, wrong payment identities, duplicate reassignment, provider outages, ambiguous initialization, posting failures, immutable history, and restricted runtime privileges.

The adapters follow [Paystack transactions](https://paystack.com/docs/api/transaction/), [Paystack webhooks](https://paystack.com/docs/payments/webhooks/), [OPay Nigeria checkout](https://documentation.opaycheckout.com/cashier-create), [OPay status queries](https://documentation.opaycheckout.com/query-payment-status), [OPay callback signatures](https://documentation.opaycheckout.com/callback-signature), and [OPay API signatures](https://documentation.opaycheckout.com/api-signature).
