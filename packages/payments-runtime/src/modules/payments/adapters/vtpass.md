# Service processors and VTpass

AxiaPay owns its payment contracts and processor pipeline. Airtime, Data, TV subscription, Electricity, Education, Insurance and Merchant payments each compose `ServicePaymentProcessor` directly with an explicit category and a `ServiceProcessorAdapter` implementation. Another provider can implement the same contract without replacing the processor, HTTP workflow, wallet rules or recovery worker.

`ServicePaymentProcessor` shares the stateless `toRequest → execute → toSubmission` sequence and service/account guards. Adapters own provider encoding, credentials, authenticated evidence and optional preparation capabilities. `PaymentExecutionService` retains durable submission claims and returned payment-ID/fingerprint checks; wallet services retain financial authorization and settlement.

## Configuration and publication

The API and worker use `VtpassPaymentsModule.register()`. Its router retains the existing `vtpass:<environment>:<partnerAccountId>` key and ledger binding for historical Airtime recovery. The legacy Airtime-only module remains available for deliberately scoped consumers.

Apply migration `202610160012-service-processor-contracts.js` before deploying the new query paths. Configure matching `VTPASS_ENVIRONMENT`, `VTPASS_API_KEY`, `VTPASS_SECRET_KEY`, `VTPASS_PARTNER_ACCOUNT_ID` and optional `VTPASS_FEE_ACCOUNT_ID` in API and worker. Add `VTPASS_PUBLIC_KEY` for GET variations and insurance choices. Existing Airtime-only settings still work without that GET credential.

No catalogue entries, retail prices, fees, insurance terms or ledger accounts are seeded or enabled automatically. VTpass provisioning and product whitelisting remain operator actions. Production configuration requires `live`.

GET requests use API/public keys; POST requests use API/secret keys. Origins are fixed, redirects and environment proxies are disabled, and full-read deadlines and decoded-byte limits apply. Errors retain controlled classifications without provider bodies or credentials. Module construction performs no network requests.

## Reviewed protocols

| First-party service       | VTpass mapping                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Airtime                   | Existing MTN, Airtel, GLO and 9mobile/T2 mappings                                                            |
| Mobile data               | MTN, Airtel, GLO, GLO SME and 9mobile data variations                                                        |
| TV                        | DSTV/GOTV fixed-bouquet changes and Startimes plans                                                          |
| Electricity               | Both meter modes for Ikeja, Eko, Kano, Port Harcourt, Jos, Ibadan, Kaduna, Abuja, Enugu, Benin, Aba and Yola |
| Education                 | Verified JAMB candidate PINs, WAEC checker cards and WAEC registration tokens                                |
| Insurance                 | Third-party motor and personal-accident purchase protocols with explicitly reviewed preparation requirements |
| Merchant/service payments | The common billersCode/phone envelope with explicitly reviewed merchant definitions                          |

Operator `providerProductCode` values use `serviceID:variation_code` for fixed plans, such as `mtn-data:<current-variation>` or `dstv:<current-bouquet>`. Electricity uses the service ID alone; immutable `electricityMeterType` supplies its mode. Customers choose first-party product UUIDs, never provider codes or routing keys.

Account-based Smile/Spectranet data, phone-based Showmax, dynamic bouquet-renewal offers, institution-fee protocols and other insurance products need distinct reviewed mappings. Their identifiers are rejected by these adapters rather than being silently interpreted as another service. The same provider-neutral processors can use those implementations independently.

## Response evidence

Response parsing follows each endpoint's documented fields. Purchase/requery transactions use `status`, `product_name`, `unique_element`, `unit_price`, `quantity`, `type`, `amount` and `transactionId`, correlated with envelope `requestId` and `amount`. `serviceID` and `variation_code` belong to requests and variation discovery; they are not transaction evidence. Variation discovery accepts both documented spellings, `variations` and `varations`.

Account verification reads `Customer_Name` and optional `Address`; documented meter flags/echoes are `WrongBillersCode`, `Can_Vend`, `Meter_Number` and `Meter_Type`. [PHED](https://vtpass.com/documentation/phed-api/) spells its meter echo `MeterNumber`; both documented forms are correlated. There is no generic `content.error` contract. Education receipts use JAMB `Pin`/`purchased_code`, WAEC checker `cards[].Pin`/`cards[].Serial`, and WAEC registration `tokens`/`purchased_code`; lowercase card-field aliases are unsupported.

Electricity's `token`, `purchased_code`, `exchangeReference`, `units`, `kct1`, `kct2`, `resetToken` and `configureToken` are documented. Insurance option parent keys `VehicleMakeCode` and `StateCode` are also documented. Reversal-specific `wallet_credit_id` is required by the [reversal update contract](https://vtpass.com/documentation/transaction-reversal-webhook-api/); it is not required for successful purchases. These evidence parsers do not create a webhook receiver or authenticate inbound callbacks.

## Quotes, recipients and recovery

The optional `verifyPurchaseTerms` capability checks current external terms during quote creation and again before a new hold, outside database transactions. Fixed-plan adapters verify exact current variation prices. Repricing requires another review; it never changes an accepted principal. VTpass supplies no price lock, so final evidence must still match the accepted amount.

`contactPhoneNumber` is separate from a meter, smartcard, candidate or merchant recipient. It is saved in the quote and bound into new fingerprints. Existing quotes without the new fields preserve their original fingerprints.

- Data sends `recipientPhoneNumber` as the target `billersCode`, independently of the delivery contact.
- TV/electricity retain owner/product-bound `accountValidationId`. Verification checks explicit meter echoes and meter type. Prepaid receipts preserve ordered key-change and recharge tokens; postpaid receipts contain no invented token.
- JAMB retains `educationValidationId` and a contact phone. WAEC voucher revisions set `educationRecipientVerificationRequired=false`, use an explicit `recipientPhoneNumber` for delivery and require any supplied contact to match it. WAEC has no fabricated candidate verification. Checker cards and registration token arrays are parsed separately, preserving leading zeros.
- Merchant products use `merchantRecipientIdentifier` and a contact phone. The account or invoice is reviewed by the customer; a valid shape does not imply independently verified ownership.

`lookup` uses only the saved claim timestamp/payment UUID to query the original reference. It bypasses current product eligibility, plan-price requests and insurance option lookups. Retain historical protocol metadata and provider registrations while obligations remain unresolved. Timeouts, missing records and exhausted checks never establish a final financial failure or authorize another purchase.

VTpass lists `other-services` but publishes no universal schema for every merchant. `VtpassMerchantPaymentAdapter` therefore accepts explicit product-name, transaction-type, variation and biller mappings at composition. It never enables arbitrary discovered service IDs. A merchant with another request/evidence protocol can implement the same `ServiceProcessorAdapter` contract with the `merchant` category. Buying merchant credit never sends SMS messages or performs unrelated merchant actions.

## Insurance facts, preparation and issuance

Insured profiles support meaningful next-of-kin, occupation, vehicle and location facts. Provider option codes stay private. `GET /v1/payments/insurance-products/:productId/options?field=...` returns product-requested capacity bands, makes, models, colours, states and local areas. A model requires its selected make as `parentValue`; a local area requires its selected state. The adapter checks parent relationships and translates names into codes per invocation, without mutable current-payment state.

Existing insurance products retain provider-verified eligibility and requested-date semantics. VTpass product revisions explicitly select `eligibilityMode: submission_requirements` and `coverageStartMode: provider_assigned`, and require all facts needed by their protocol. Preparation checks product rules, current premium and supported option relationships. This establishes submission readiness, not underwriting acceptance. Application responses report `eligibilityStatus: submission_ready` and the explicit preparation/start modes; existing verified products retain `eligible`. Provider-assigned starts require a same-day request under the application's existing UTC date convention. New terms and fields require a new immutable product revision.

VTpass's documented purchase/requery responses confirm premium payment and may supply a certificate link. They do not confirm the complete first-party insured-name/coverage-period policy proof. Premium success therefore remains separate from `insurance_policy` fulfilment and issued documents. The adapter never invents dates, policy numbers or active cover. Missing policy/document evidence remains observable and can escalate through existing recovery. Complete insurance fulfilment still needs authenticated issuer evidence satisfying the first-party contracts.

Certificate retrieval is isolated from VTpass credentials, accepts only the allowlisted issuer path and actual bounded PDF bytes, and follows no redirects. An HTML certificate link is never relabelled as a PDF. No raw upstream URL enters customer-facing document metadata.

## Verification and references

Tests cover interchangeable provider protocols, exact wire mappings, key separation, current-price checks, evidence mismatches, candidate/meter verification, token/PIN variants, insurance option parents, safe document reads, concurrent consent, real PostgreSQL holds/journals and original-reference recovery. Provider transport is simulated; these checks do not establish live provisioning or availability.

Mappings were checked against VTpass's [authentication](https://vtpass.com/documentation/authentication/), [data](https://vtpass.com/documentation/mtn-data/), [DSTV](https://vtpass.com/documentation/dstv-subscription-api/), [electricity](https://vtpass.com/documentation/ikedc-ikeja-electricity-distribution-company-payment-api/), [JAMB](https://vtpass.com/documentation/jamb-pin-vending-api/), [WAEC checker](https://vtpass.com/documentation/waec-result-checker-api/), [WAEC registration](https://vtpass.com/documentation/waec-registraton-api/), [motor insurance](https://vtpass.com/documentation/third-party-insurance/), [personal accident](https://vtpass.com/documentation/personal-accident-insurance-api-2/) and [category discovery](https://vtpass.com/documentation/available-services/) documentation. Recheck protocol changes before enabling new mappings.
