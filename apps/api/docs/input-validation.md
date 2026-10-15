# Input validation boundaries

HTTP input is validated and explicitly normalized by DTO decorators through the global Nest pipe before a controller calls a service. Services receive plain typed commands and own business workflows. A call through another service or a worker is not a reason to repeat raw input validation inside that workflow.

`src/shared/validation/input-validation.ts` owns `createInputValidationPipe()` and `withValidatedInput`. The HTTP module and non-HTTP wrapper share the same pipe configuration: unknown fields and malformed nested objects are rejected, primitive credential conversion is disabled, and safe errors omit submitted values. Validation rules remain in one DTO definition.

## Responsibilities

| Concern                                                                        | Owner                                                   |
| ------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Required fields, types, lengths, enum values, UUID/phone/email formats         | DTO + pipe                                              |
| Password code-point length; code strings and leading zeros                     | Authentication DTO constraints                          |
| Declared contact/email trimming and canonical case                             | DTO class-transformer metadata                          |
| Pagination bounds and static mutually exclusive recipient selectors            | DTO + pipe                                              |
| Mapping validated query strings and monetary integer strings                   | Controller or non-HTTP adapter                          |
| Account ownership, credential correctness, session/device validity             | Service/domain policy                                   |
| Selected product's required/allowed fields, consent, current terms and expiry  | Service/domain policy                                   |
| Exact money value invariants, available funds, pricing and settlement          | Domain values + service transaction                     |
| Actual public-key parsing, signature verification, provider-result correlation | Crypto/provider capability and domain evidence policy   |
| Untrusted job, CLI, event or integration payload                               | Non-HTTP validation wrapper/schema before service logic |
| Startup settings and provider-route configuration                              | Configuration/composition boundary                      |

A boundary accepts a well-formed password; the service verifies it against the stored hash. A boundary accepts a well-formed device signature; the crypto capability verifies it against the registered key. A boundary accepts a properly formatted amount; the domain still protects exact arithmetic and the current product's price/limits. These responsibilities remain distinct.

## Non-HTTP entry points

Use the same appropriate DTO before mapping an untrusted payload to a service command:

```ts
await withValidatedInput(PasswordLoginDto, payload, (input) =>
  authentication.loginWithPassword({
    contact: input.contact,
    password: input.password,
    clientIp: trustedContext.clientIp,
  }),
);
```

The callback is never invoked when validation fails. Keep caller identity, client IP, server-selected purpose and other trusted context outside an untrusted payload; the DTO rejects attempts to over-post them. A CLI/job adapter can translate the validation exception into its own rejection outcome. Do not wrap already validated service-to-service calls or import DTOs/wrappers into services. A future worker must define its input contract at its entry point before doing any business work.

`SessionTokenInputDto` covers non-HTTP opaque session credentials. HTTP bearer syntax is already checked by `readBearerToken` in the guard/controller boundary. Catalogue adapters validate `ProductQueryDto` before mapping its bounded string `limit` to the numeric service contract. Provider webhook adapters continue verifying their own signatures and payload schemas; trusted-provider evidence still needs authoritative business correlation.

## Audit changes

The audit removed repeated request-format checks from authentication/device, catalogue, payment, wallet, funding, and airtime-conversion services. Contact and receipt-email canonicalization now happen before service invocation. Device labels, UUIDs, base64url shapes, passwords, codes, catalogue filters, recipient-selector cardinality, narration, and insured-profile formats are input-boundary concerns. Product-selected recipient type, current eligibility, accepted terms, future birth-date rules, quote expiry, ownership, money invariants, cryptographic key parsing, and provider evidence remain authoritative workflow/domain checks.

Email normalization preserves plus aliases and dots. Phone input requires explicit international format. Password whitespace is preserved and Unicode code-point limits include variation selectors. Identifiers and one-time codes are never coerced from numbers. Unknown input fields and nested object extensions are rejected. Malformed login passwords return `400 INVALID_INPUT`; valid-shaped incorrect credentials keep the generic `401 INVALID_CREDENTIALS` response.

ESLint prevents services and domain/use-case code from importing DTOs, validation/pipes, or request validation libraries. DTO declarations and the shared pipeline remain framework-owned adapter code.

## Verification

Boundary tests prove malformed HTTP input never invokes authentication service operations. The same wrapper tests reject malformed non-HTTP payloads without running the callback. They cover nested/extra/null fields, contact normalization, Unicode password limits, leading-zero codes, device identifiers and labels, bounded filters, recipient selectors, narration and insurance formats. Existing service/domain and integration tests retain authorization, product policy, credential verification, replay, concurrency, expiry, financial invariants and recovery coverage.

The implementation follows the installed Nest/class-validator APIs and their [official validation guidance](https://docs.nestjs.com/techniques/validation). No new dependency is required.
