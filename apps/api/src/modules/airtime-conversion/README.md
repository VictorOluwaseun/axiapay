# Airtime conversion contracts

This is an inbound airtime-to-wallet workflow for individuals. It owns eligibility checks, reviewed rates and fees, consent, transfer instructions, independent receipt verification, wallet credit and recovery. It does not use outbound airtime purchases or reserve customer wallet funds.

`AirtimeConversionModule.register()` is included in the API bootstrap with an empty route registry. It publishes no network or commercial terms and connects no provider. Eligible offers, source verification requirements, rates, fees, supported currencies, operating limits and exception-resolution terms remain release decisions. The product basis is F12 / IND 019–020 in the repository's linked individual MVP drafts.

## Customer API

All routes require the current bearer session and return `Cache-Control: no-store`. Ownership is checked within the service as well as at delivery. Missing and inaccessible quotes/conversions both return 404. All monetary and rational integers are decimal strings; currency comes from the owned wallet.

| Method | Route under `/v1`                                    | Purpose                                                                                                 |
| ------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| GET    | `/wallets/:walletId/airtime-conversion-offers`       | Discover explicitly enabled terms for an owned, open wallet; empty when unconfigured.                   |
| POST   | `/airtime-conversions/quotes`                        | Check source eligibility and persist immutable review terms.                                            |
| GET    | `/airtime-conversions/quotes/:quoteId`               | Read the original owned review, including its expiry.                                                   |
| POST   | `/airtime-conversions`                               | Explicitly accept one reviewed quote under an owner-scoped logical key.                                 |
| GET    | `/airtime-conversions/by-request-key?requestKey=...` | Recover a lost acceptance response.                                                                     |
| GET    | `/airtime-conversions/:conversionId`                 | Observe persistent progress without external I/O or credit.                                             |
| POST   | `/airtime-conversions/:conversionId/reconcile`       | Inspect the original transfer identity and recover verified wallet credit. No body, or an empty object. |

Quote input:

```json
{
  "walletId": "ae9b89ce-2d74-486d-9a42-cefe709caf7c",
  "offerId": "an-id-returned-by-offer-discovery",
  "sourcePhoneNumber": "+2348012345678",
  "airtimeMinorUnits": "100000"
}
```

Acceptance input:

```json
{
  "quoteId": "8e079388-31dc-40e6-b235-7cbb4fb38c08",
  "requestKey": "a-persisted-logical-conversion-identity"
}
```

Save the key before submission. Retry with the same quote/key after uncertainty, or resolve it with the key lookup. Each quote permits one logical conversion; reusing a key for different terms or accepting the same quote with another key conflicts. Unknown fields, numeric money, scientific notation, leading zeros and client receipt/success claims are rejected. Network is determined by the selected offer and authoritative eligibility, never by a phone prefix.

## Exact pricing and consent

The implemented calculation contract uses one currency and integer minor units:

```text
gross = floor(airtimeFaceValue × rateNumerator / rateDenominator)
fee   = fixedFee + ceil(gross × feeBasisPoints / 10000)
net   = gross − fee
```

These explicit rounding rules are implementation decisions. No rate or fee value has been selected for launch. Arithmetic uses bigint, including intermediate multiplication. Limits and steps apply to the airtime face value; gross/net amounts must fit positive PostgreSQL bigint and fees must leave positive proceeds. Quotes disclose the basis, rounding, rate, fixed/proportional fees, gross, aggregate fee, net, limits and validity. Eligibility validity can shorten the configured quote validity.

New acceptance checks quote expiry and the exact current offer/product/realm binding while the quote is locked. Changed or withdrawn terms require a new review. Accepted terms remain unchanged thereafter: retries never reprice, replace the destination wallet, extend the transfer deadline or substitute another provider. The receive deadline starts at acceptance and is distinct from quote expiry.

## Progress and recovery

| State                  | Meaning / next action                                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `preparing`            | Accepted intent exists but instructions are unavailable; reconcile the original identity.                                           |
| `awaiting_receipt`     | Fixed instructions are available within the transfer window; only the reviewed source, face value, destination and deadline apply.  |
| `verification_pending` | The transfer window elapsed without terminal proof; reconcile. Expiry is not proof that no airtime moved.                           |
| `credit_pending`       | Exact, timely receipt is verified and durably saved; recover ledger credit under the same identity.                                 |
| `credited`             | A matching committed wallet journal exists; `operationId` links credit to this conversion.                                          |
| `exception`            | Wrong amount/currency, late receipt, changed source/destination/net terms, failed verification or reused movement; contact support. |

Wrong amounts and late receipts retain observed face value/currency and actual receipt time where structurally valid. They never trigger partial credit, repricing or an invented refund. Terminal observations remain immutable even if a later lookup changes its answer. Exception history is retained for an audited support process; automatic exception resolution and an operator financial-adjustment API require approved operating rules and are outside this contract.

Preparation is claimed once in SQL before external I/O. A lost response or crashed caller can be recovered only with non-executing lookup of the original reference; the claim never expires into permission to resubmit. An accepted request whose preparation never started can still prepare once within its original window. Deadlines alone never delete accepted history or create failure evidence.

Actual authenticated receipt time determines timeliness: a timely receipt discovered after the deadline can still credit, while an actual late transfer becomes an exception. Customer assertions that airtime was sent do not change the financial state.

Verified evidence commits before wallet credit. Wallet settlement rechecks destination currency and closure under its authoritative lock, then posts one balanced journal: debit the bound partner clearing account and credit wallet available funds for **net proceeds only**. Frozen wallets can receive; closed wallets cannot. Pricing fees are disclosed deductions from gross proceeds; partner airtime inventory, fee-income recognition and partner settlement accounting need their own approved commercial model and are not invented as extra customer ledger movements.

Credit uses the wallet's shared `funding:{partnerAccountId}` scope and the original external movement identity, so replay cannot credit twice or redirect the movement to another wallet/value. A journal from another funding mechanism is never presented as this conversion's credit, even with matching wallet/value. Saved proof allows recovery after lookup outage, offer withdrawal or adapter removal. A ledger failure leaves `credit_pending`, preserving the obligation. Reads never post credit; acceptance/reconciliation coordinate it explicitly.

## Adapter boundary and composition

Implement `AirtimeConversionProvider` in a focused infrastructure adapter, then inject `ConversionRoute[]` with `useValue`, `useFactory` or `useExisting` through `AirtimeConversionModule.register({ imports, routes })`. No placeholder adapter or external endpoint is installed.

The owned capability contract is:

- `checkEligibility`: non-financial authoritative eligibility for the exact source, network, upstream product and face value. Return a bound evidence reference and expiry, or a safe ineligible result.
- `prepareTransfer`: issue instructions only, at most once after durable acceptance. It must not send airtime itself or authorize a wallet credit.
- `inspectTransfer`: authenticated, non-executing original-identity lookup that can recover instructions and report pending, a canonical cleared receipt, or evidenced verification failure. Timeouts throw; they never imply failed verification.

`providerId` is an immutable realm identity, including the relevant environment/merchant context. `partnerAccountId` identifies an administratively provisioned `partner_funds` account in the offer currency. New bindings are required for changed realms/accounts; accepted work always resolves its original binding. Withdrawing new offers can retain the old binding for recovery. Each offer ID is unique, with explicit versioned terms and an upstream product code hidden from customers.

Every prepare/lookup receives the same conversion ID and complete first-party fingerprint covering owner, wallet, source, price, product, eligibility and deadlines. Adapters must persist this correlation, independently authenticate lookup results, confirm source eligibility and accepted net obligations, and supply safe customer instructions. They must never log credentials, raw payloads, phone numbers or fingerprints. A receipt must match the original conversion/fingerprint, source/network, fixed receiving number/instruction reference, exact face value/currency, agreed net value/currency and actual receipt time. One stable external movement ID represents one economic airtime receipt across lookup retries, transports and funding features sharing that account.

Provider credentials, webhook authentication, settlement/reversal evidence, queue dispatch and provider-specific source security remain adapter/integration work. This feature exposes no customer success callback or unsigned receipt-insertion API. Services can be reused by a future authorized recovery worker; current delivery explicitly reconciles accepted work and uses no placeholder BullMQ job.

## Storage and rollout

Apply `202610140009-airtime-conversion.js` before deploying feature queries. As the migration owner, call `select grant_airtime_conversion_runtime_access('your_runtime_role')` alongside existing authentication/wallet grants. The API runtime must not own the tables. The migration preserves existing funding/payment history and wallet balances, creates no conversion history and has no destructive rollback.

Quotes, accepted identities, fixed instructions and terminal proof are immutable. Runtime updates permit only a first preparation claim; quote update permission exists solely for transaction row locking, with mutation blocked by triggers. SQL also enforces exact arithmetic, wallet ownership/currency, clearing-account kind/currency, accepted deadlines and matching successful receipt proof. Unique owner/key, quote and partner/movement constraints protect retries and concurrency. Repositories borrow the shared Kysely pool, own transactions and bypass caching for all financial state. No cache invalidation or outbox protocol is claimed without an implemented use.

Tests cover exact rounding/overflow, unconfigured capability discovery, real session ownership, DTO rejection, quote expiry and changed terms, concurrent acceptance/credit, lost instructions, pending lookups, mismatch/late/failure exceptions, movement reuse across funding features, credit recovery without adapters, immutable storage, forged proof rejection and forward upgrade preservation. Integration checks use restricted roles and disposable PostgreSQL; they never run migrations against the local development database.
