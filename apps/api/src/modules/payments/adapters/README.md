# VTpass domestic airtime

`VtpassAirtimeAdapter` supplies the provider-specific stages injected into AxiaPay's `ServicePaymentProcessor('airtime', adapter)`. It owns encoding, authenticated fixed-origin HTTP, runtime response parsing and evidence correlation. The processor owns sequencing; payment services retain durable claims, wallet authorization, settlement and recovery. No dependencies or startup HTTP calls are added.

## Configuration and routing

Set all of `VTPASS_API_KEY`, `VTPASS_SECRET_KEY`, and `VTPASS_PARTNER_ACCOUNT_ID`, with `VTPASS_ENVIRONMENT=sandbox` or `live`. Optional `VTPASS_FEE_ACCOUNT_ID` must differ from the clearing account. Keys must come from the selected environment: their opaque values cannot independently establish their sandbox/live realm. Keep sandbox/live databases and ledger accounts separate. Production rejects sandbox integration; existing production authentication restrictions remain independent.

Accounts must already be provisioned. Nothing seeds accounts, products, prices or balances. Catalogue revisions use private routing key `vtpass:<environment>:<partner-account-uuid>`, currency `NGN`, and these mappings:

| First-party network         | Provider product code (`serviceID`) |
| --------------------------- | ----------------------------------- |
| `mtn`                       | `mtn`                               |
| `airtel`                    | `airtel`                            |
| `glo`                       | `glo`                               |
| `9mobile`, `t2`, `etisalat` | `etisalat`                          |

Provider receipt names match the documented product names exactly; changed names require verification and an adapter update. Nigerian E.164 recipients (`+234` plus ten digits) become domestic strings with a leading zero. Prefixes never select the network. Smile needs a separate account/variation flow. Data, international airtime and other categories are unsupported by this adapter.

One pure `validate` guard checks catalogue products and full quotes before processing; its name does not imply that a purchase has been submitted. The processor owns service/account routing; the adapter checks currency and network/product compatibility, with recipient checks only for quotes. The same validator runs for availability and before new holds without performing network I/O or financial authorization. Validation throws explicit errors and does not call formatters. Phone and naira formatters only transform already validated values; domain Money owns amount bounds. Unsupported terms cannot claim submission or reserve funds. Existing providers without this optional hook keep their behaviour; existing holds retain their recovery obligations.

`VtpassAirtimeModule` injects the configured adapter into a plain processor through a Nest factory. `PaymentIntegrationModule` supplies those registrations to the existing feature. Partial settings reject startup; absent credentials leave registrations empty. There are no demo fallbacks. The default configuration supports one merchant account per deployment. Retain old registrations for existing obligations when changing accounts/environments; never rebind accepted routing keys.

## Identity, money and outcomes

The request reference uses saved `submissionStartedAt` as `YYYYMMDDHHmm` in Africa/Lagos followed by the payment UUID without hyphens. Persisted claims precede transport. Restarts and later-day enquiries derive the same reference, never a fresh current-clock identity. Crossing midnight before the first request is accepted may require operational reconciliation, never a blind purchase retry.

Kobo/naira conversion uses bigint arithmetic. The HTTP body inserts an exact validated numeric decimal token without converting money through JavaScript numbers. Node 24 JSON source metadata preserves raw numeric tokens, including fractional amounts and long transaction IDs. Exponent notation, extra precision and ledger overflow are rejected. Commission and net partner debit never redefine customer principal.

POST calls use `api-key`/`secret-key` headers on fixed environment HTTPS origins. Redirects are rejected, requests have an eight-second deadline, response streaming is capped at 256 KiB, and no retries occur inside the adapter. Errors retain safe HTTP/timeout categories, excluding credentials, recipients and raw upstream bodies.

Envelope `000` alone is not delivery. Success requires inner `delivered` plus matching request ID, exact principal/unit price/envelope amount, quantity, airtime type, explicit product identity and recipient in `unique_element`. The separate `phone` field is merchant/contact information. Actual upstream transaction IDs identify settlement.

Fully correlated `016`/`091` with inner `failed` permit safe release under documented outright-failure/no-charge semantics. `040` with inner `reversed` additionally requires `wallet_credit_id`. A reversal envelope's amount is the net partner refund, so only inner principal is matched to customer principal. Minimal rejection responses lacking transaction identity/amount/recipient cannot automatically release funds.

The reversal fields come from VTpass's documented reversal-update data, whose shape differs from success. Purchase/requery correlation does not inspect transaction-level `serviceID`, `variation_code` or `currency`. Provider request fields are not assumed to be echoed in a response.

Initiated, pending, duplicate (`014`), missing (`015`), ambiguous and unknown observations remain unresolved. Transport errors preserve the existing claim and hold. Recovery calls only `/api/requery` with the original reference, including after restart or quote expiry; it never repurchases. Webhooks are not enabled. Missing/inconsistent evidence may require provider investigation.

Tests replace outbound HTTP and exercise exact encoding, evidence checks, limits, timeouts and DI. PostgreSQL tests cover capture/replay, timeout recovery, safe release and rejection before holds. No credentialed sandbox or live purchase has been performed.

## Official contracts

- [Authentication](https://vtpass.com/documentation/authentication/)
- [MTN](https://vtpass.com/documentation/mtn-airtime-vtu-api/), [Airtel](https://vtpass.com/documentation/airtel-airtime-vtu-api/), [Glo](https://vtpass.com/documentation/glo-airtime-vtu-api/), [9mobile](https://vtpass.com/documentation/9mobile-airtime-vtu-api/)
- [Reference format](https://vtpass.com/documentation/how-to-generate-request-id/) and [status enquiry](https://vtpass.com/documentation/re-query-services/)
- [Response codes](https://vtpass.com/documentation/response-codes/) and [reversals](https://vtpass.com/documentation/transaction-reversal-webhook-api/)
- [Smile's separate flow](https://vtpass.com/documentation/smile-network-payment-api-2/)

## Error explanations

Preparation guards and provider/protocol failures retain the existing public error codes and HTTP statuses. A closed `PaymentErrorReason` catalog adds specific, first-party descriptions: unsupported currency/product, mismatched network or recipient, incomplete evidence, invalid JSON, timeouts and HTTP categories. Wrapping a known `PaymentError` preserves its reason and cause. Unknown errors never supply public text.

The payment HTTP filter selects the fixed description by reason instead of serializing exception messages, which could be changed or contain external data. Responses keep the shared error envelope and request ID; failure logs include that same safe description and request ID. Credentials, raw provider bodies, phone numbers, account keys and submitted values never enter these descriptions. Pending provider observations remain pending and are not relabelled as final failures.

The transport uses the shared Axios Node HTTP policy with raw text responses and unchanged serialized request bodies. Exact decimal JSON is not parsed or re-encoded by Axios. Redirects remain disabled, purchase/enquiry keep their eight-second absolute deadlines, and response-size/timeout errors retain their specific safe reasons.

The production-shaped Airtime fixture confirms `amount: "100"`, `unit_price: "100"`, envelope `amount: "100.00"` and numeric `quantity: 1`. Both numeric and parsed-text quantities are accepted. A `commission` of 3 and `total_amount` of 97 describe provider pricing; they never reduce the quoted customer principal or substitute for recipient/request correlation. Test contacts and references are synthetic.
