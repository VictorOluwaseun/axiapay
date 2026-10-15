# Airtime processing

`AirtimeProcessor` is AxiaPay's concrete, framework-independent implementation of the shared submission sequence:

```text
PaymentExecutionService
  → AirtimeProcessor.submit(payment)
      → injected adapter.toRequest(payment)
      → injected adapter.execute(request)
      → injected adapter.toSubmission(response, payment)
```

Each provider implements `AirtimeProcessorAdapter<ProviderRequest, ProviderResponse>` rather than duplicating the processor. `providerKey` identifies one deployment account/environment and must match the accepted quote. Wire types remain at the adapter/composition boundary. The processor accepts the existing first-party `ServicePayment` and returns `ProviderPaymentResult`, so no HTTP contract, database schema, pricing, wallet rule or payment state changes.

The adapter owns provider request encoding, authenticated upstream evidence, runtime response validation, recipient/product/amount correlation, safe error translation, bounded network timeouts and redacted diagnostics. `toRequest` and `toSubmission` perform no network I/O. Mapping happens per call; neither the processor nor a shared adapter may keep mutable current-payment state. Exact minor-unit values must not pass through lossy floating-point conversions.

`PaymentExecutionService` still claims a persisted submission once after reservation. The processor does not retry, post journals, invent final failures or provide exactly-once delivery. A transport or mapping error propagates to the existing service, which retains its submission claim and hold. `lookup` calls the adapter's dedicated enquiry implementation; it never re-enters `toRequest`/`execute`/`toSubmission`. Enquiries may have a different protocol and must query the original merchant identity without purchasing. Pending and unsafe failure observations retain their existing settlement semantics. The processor additionally checks first-party identity/fingerprint correlation; a fingerprint is not provider authentication.

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
        adapter: new AirtimeProcessor(adapter),
        partnerAccountId: configuredPartnerAccountId,
        feeAccountId: configuredFeeAccountId,
      },
    }),
  },
});
```

The provider module/token/types and configured account IDs above are illustrative. The implemented [VTpass airtime adapter](../adapters/README.md) now follows this pattern with optional validated configuration. Multiple injected adapters get separate processors and immutable routing keys; changed account/environment bindings need a new key. Other categories retain their existing registrations. Without provider configuration, default API composition still has no payment adapters or seeded catalogue. There is no simulated production fulfilment.

Unit checks cover exact mapping, unresolved/final observations, propagation of errors, rejected routing/evidence and overlapping calls. The Nest composition test verifies two independently injected adapters and timeout recovery through the existing execution service. PostgreSQL payment integration fixtures route airtime through the real processor, retaining ledger, duplicate-submission, concurrency and recovery coverage.
