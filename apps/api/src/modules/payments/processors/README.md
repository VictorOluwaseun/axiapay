# Service processing

`ServicePaymentProcessor` owns the stateless submission sequence and service/account guards for every payment category. Compose it directly with an explicit category and a `ServiceProcessorAdapter<ProviderRequest, ProviderResponse>`, for example `new ServicePaymentProcessor('airtime', adapter)`. Category wrappers and identical adapter aliases are unnecessary; each provider retains its concrete wire formats and evidence rules.

The Airtime example is AxiaPay's concrete, framework-independent implementation of the shared submission sequence:

```text
PaymentExecutionService
  → ServicePaymentProcessor.submit(payment)
      → injected adapter.toRequest(payment)
      → injected adapter.execute(request)
      → injected adapter.toSubmission(response, payment)
```

Every provider protocol implements `ServiceProcessorAdapter<ProviderRequest, ProviderResponse>`. Providers share the processor and keep service-specific encoding, validation and receipts inside their concrete adapters. `providerKey` identifies one deployment account/environment and must match the accepted quote. Wire types remain at the adapter/composition boundary. The processor accepts the existing first-party `ServicePayment` and returns `ProviderPaymentResult`, while HTTP, persistence, pricing, wallet and financial state decisions remain in their existing owners.

The adapter owns provider request encoding, authenticated upstream evidence, runtime response validation, recipient/product/amount correlation, safe error translation, bounded network timeouts and redacted diagnostics. `toRequest` and `toSubmission` perform no network I/O. Mapping happens per call; neither the processor nor a shared adapter may keep mutable current-payment state. Exact minor-unit values must not pass through lossy floating-point conversions.

`PaymentExecutionService` still claims a persisted submission once after reservation. The processor does not retry, post journals, invent final failures or provide exactly-once delivery. A transport or mapping error propagates to the existing service, which retains its submission claim and hold. `lookup` calls the adapter's dedicated enquiry implementation; it never re-enters `toRequest`/`execute`/`toSubmission`. Enquiries may have a different protocol and must query the original merchant identity without purchasing. Pending and unsafe failure observations retain their existing settlement semantics. `PaymentExecutionService` is the single owner of returned payment-ID/fingerprint checks for every provider observation, including pending results, before evidence can be recorded. Adapters still authenticate and correlate upstream proof; a fingerprint is not provider authentication.

The adapter's optional `validate` hook governs new purchases and is not called by `lookup`. Enquiries check only the processor's category and provider-account binding before delegating; they do not reapply current product/network mappings or purchase encodings to accepted snapshots. Provider authentication and request/recipient/product/amount evidence checks still apply. Keep historical evidence metadata and original provider registrations while they own unresolved obligations; withdrawing purchase eligibility must not remove recovery support.

## Dependency injection

Use the existing `PaymentsModule.register({ imports, fulfilment })` composition factory to inject adapters and construct plain processors. No additional registry, service locator or DI framework is needed. For example, once an actual provider module exists:

```ts
PaymentsModule.register({
  imports: [ProviderAirtimeModule],
  fulfilment: {
    inject: [AIRTIME_ADAPTER],
    /** Compose one processor for an explicitly configured provider account. */
    useFactory: (adapter: ConfiguredAirtimeAdapter): PaymentProviders => ({
      [adapter.providerKey]: {
        adapter: new ServicePaymentProcessor('airtime', adapter),
        partnerAccountId: configuredPartnerAccountId,
        feeAccountId: configuredFeeAccountId,
      },
    }),
  },
});
```

The provider module/token/types and configured account IDs above are illustrative. The implemented [VTpass airtime adapter](../adapters/README.md) now follows this pattern with optional validated configuration. Multiple injected adapters get separate processors and immutable routing keys; changed account/environment bindings need a new key. The API and worker compose all reviewed categories through `VtpassPaymentsModule`; historical Airtime-only composition remains available. Without provider configuration, default API composition still has no payment adapters or seeded catalogue. There is no simulated production fulfilment.

Unit checks cover exact mapping, unresolved/final observations, propagation of errors, rejected routing/evidence and overlapping calls. The Nest composition test verifies two independently injected adapters and timeout recovery through the existing execution service. PostgreSQL payment integration fixtures route airtime through the real processor, retaining ledger, duplicate-submission, concurrency and recovery coverage.

## Validation ownership

HTTP DTOs and entry-point validation wrappers own untrusted shape, formats and static bounds. Payment services consume normalized commands and enforce current product rules, authorization, pricing, expiry, concurrency and wallet state. Authenticated provider evidence still needs independent correlation before settlement.

The processor owns service and provider-account routing; protocol validators do not repeat those guards. Configuration validates deployment account identifiers before registration. VTpass profile validation owns SKU syntax; request mapping only splits the accepted code and formats domain money once. Serializers encode that prepared request without parsing it again.

`preparePurchase` owns one pure protocol check followed by the optional current-provider-terms observation before a fresh hold. The execution service and category router delegate that combined operation without repeating its checks. Providers implementing the separate hooks retain their ordered fallback. Quote review invokes `verifyPurchaseTerms` only where an external terms check exists; providers without it retain availability reporting. Submission and recovery keep their own execution/evidence guarantees; recovery never repeats purchase validation or current-price calls.

## Current provider terms and service integration

Adapters may implement non-purchasing `verifyPurchaseTerms` to check live plan prices before review and a fresh hold. Recovery bypasses this operation and current purchase eligibility. See the [VTpass guide](../../../../../../packages/payments-runtime/src/modules/payments/adapters/vtpass.md) for the service-specific preparation capabilities, new immutable recipient/contact fields, migration and configuration. A new provider implements the same processor ports; it does not replace wallet authorization or settlement.
