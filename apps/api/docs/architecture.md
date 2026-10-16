# API architecture

The API owns HTTP delivery and API-only features under `apps/api/src/modules`. Reusable payment, wallet and catalogue features live under `packages/backend/src/modules`; API and worker both depend on that library, never on each other. `apps/worker` owns job adapters and headless bootstrap.

Code is grouped by feature under `src/modules` in each owning package. Feature folders use concrete responsibilities: `controllers`, `services`, and `repositories`, with `dtos`, `domain`, and optional `data-sources` added as needed. There are no `application` or `delivery` wrapper folders inside features. The dependency rules of Clean Architecture still apply.

```text
src/modules/<feature>/
  <feature>.module.ts       Nest providers, imports, and public exports
  controllers/              HTTP routes and transport mapping
  dtos/                     Decorated request classes and OpenAPI response contracts
  services/                 Business workflows and focused reusable policies
  repositories/
    contracts/              Framework-independent persistence contracts
    *.repository.ts         Direct storage access or data-source coordination
  data-sources/             Optional adapters for distinct storage responsibilities
  domain/                   Entities, values, invariants, and business errors
  ports/                    External capability contracts, such as code delivery
  processors/               Shared provider protocol sequences with injected adapters
  providers/                External capability implementations
  guards/                   Request authentication and route access
  filters/                  Safe transport error mapping
  interceptors/             Cross-cutting HTTP behaviour
  security/                 Concrete credential cryptography
```

The supporting folders are added when the feature needs them. Future features contain responsibility guides, not placeholder endpoints or fake services.

## Responsibility flow

The default path is `controller → service → repository → storage`. An optional data source sits between a repository and storage when it has a useful responsibility. Services own business workflows through repository contracts and external capability ports. Domain models and policies own reusable invariants. Services never receive HTTP DTOs, PostgreSQL/Redis clients, persistence rows, or concrete provider SDKs.

Keep services cohesive. Authentication groups the code lifecycle in `AuthenticationCodeService`, while `AuthenticationService` owns password login and session access. Wallet operations live in `WalletService`; `WalletReservationService` owns reserve/capture/release transitions. `HealthService` answers liveness directly. These are responsibility boundaries, not one class per action.

A separate use-case class is optional. Introduce `usecases/` only when a complex workflow benefits from independent orchestration, for example several business stages, cross-feature coordination, or substantial recovery rules. Keep extracted workflows framework-independent with explicit contracts. Code length alone is not an extraction rule, and internal reuse can use a focused service or domain policy. No API module currently requires a use-case folder.

Repositories own storage access and transaction scope, either directly or through optional data sources. Repository contracts use domain values, not SQL rows or transport DTOs. Services decide the transaction's business work; repositories provide the atomic persistence boundary. Kysely and ioredis stay inside concrete repositories or their data sources, never in services, controllers, domain code, or repository contracts.

Extract a data source for substantial storage logic, reuse, or clear separation between multiple stores. Do not require a second class that only forwards each repository method. Cache eligibility, keys, expiry, and invalidation remain repository decisions in either arrangement.

Authentication uses `PostgresAuthenticationRepository` directly for SQL, persistence mapping, and transactions. Nested repository operations reuse the current transaction connection; challenge replacement, account creation, code consumption, and session creation retain their existing atomic boundaries. Authentication reads bypass cache. `DatabaseModule` owns connection lifecycle.

Wallets retain `WalletPostgresDataSource`: ledger queries, locking, journal writes, reservations, and outbox persistence form a substantial storage responsibility. `WalletRepositoryImpl` continues coordinating it and mapping persistence records to domain values. Its transaction and cache-bypass behaviour is unchanged.

Nest modules assemble the dependency graph through constructor injection, class providers, and explicit tokens/factories for interfaces. They export feature services and guards while keeping concrete persistence private. `DatabaseModule` owns the shared Kysely pool and closes it through Nest lifecycle hooks. Tests replace individual ports or pool ownership without bypassing the feature module graph.

`AirtimeProcessor` implements the existing `ServicePaymentProvider` contract through an injected `AirtimeProcessorAdapter`. AxiaPay owns the common `toRequest → execute → toSubmission` sequence; each adapter owns provider wire formats, transport and authenticated evidence. The existing payment-module factory constructs processors from injected adapters. Lookup uses a separate enquiry path and never repeats the purchase pipeline. Durable claiming, authorization and settlement remain in payment/wallet services. See [airtime processing](../src/modules/payments/processors/README.md). Root `PaymentIntegrationModule` optionally composes the [VTpass domestic airtime adapter](../src/modules/payments/adapters/README.md) from validated configuration. A single pure adapter `validate` contract checks catalogue products and complete quotes, keeping unsupported terms out of new wallet holds; provider transport remains outside transaction locks.

`AuthenticationService`, `WalletService`, and `HealthService` are implemented. `AuthenticationModule` exposes the existing signup, login, code-authorized password recovery, session, and logout routes. `WalletModule.register({ funding, paymentOutcome })` requires trusted verifier implementations and exports `WalletService`; it registers no public wallet routes. `/health/live` confirms process liveness only.

## Outbound HTTP

Provider adapters and local Mailpit delivery use Axios 1.20.0, pinned in the owning API/shared-backend manifests and pnpm lockfile. The shared `packages/backend/src/infrastructure/http/axios-client.ts` factory owns Node HTTP transport defaults: no redirects or environment proxy routing, 256 KiB request/decoded-response limits, finite timeouts, and raw text without implicit JSON transformations. Feature adapters own fixed destinations, credentials, exact body serialization, provider parsing and business error mapping. Axios types remain inside infrastructure and concrete adapters, outside services, domain models and capability contracts.

Each client registers its request and response interceptors once on that instance. The request interceptor composes the configured full-read deadline with optional caller cancellation, leaving credentials and signed bytes unchanged. The response interceptor rejects non-2xx statuses and projects transport failures into `OutboundHttpError`, retaining only a controlled code and optional HTTP status. Raw Axios configuration, requests, responses, exception messages and causes are never retained. Feature adapters map these safe failures to their existing payment/funding/delivery errors; authentication, rate-limit meanings, provider payloads and financial outcomes remain their responsibility. No global interceptors, automatic retries, token refresh or implicit purchase replay is introduced.

The existing exact-number parsers retain provider identifiers and money before JavaScript numeric rounding. OPay signs the same bytes Axios sends. Provider HTTP failures, response limits and timeouts retain existing payment/funding uncertainty and reconciliation. Interceptor checks cover isolation across clients, request-preparation failures, safe HTTP statuses and removal of credentials/response bodies from normalized errors. The implementation follows the installed Axios API and [instance interceptor guidance](https://axios-http.com/docs/interceptors).

The shared adapter consumes Axios's decoded Node response stream, counting bytes before buffering more than 256 KiB. Overflow raises the owned `RESPONSE_TOO_LARGE` failure; classification never inspects Axios messages or treats generic stream errors as proof of excess size. Only the underlying transport's `maxContentLength` is disabled so Axios cannot replace this controlled failure with its shared error code; the application counter enforces the same decoded-byte limit, including compressed and chunked responses. Node async iteration destroys the stream on overflow or failure. The request interceptor's native AbortSignal remains active through body consumption, including a response that stalls after its headers. UTF-8 text, leading-BOM handling, exact request bytes, outgoing limits and redirects retain their existing contracts. Node 24.19.0, types/build, real loopback HTTP checks and payment/funding/Mailpit tests verify the policy; no dependency upgrade is included. See [Axios request configuration](https://axios-http.com/docs/req_config) and [Node 24 stream iteration](https://nodejs.org/docs/latest-v24.x/api/stream.html#readablesymbolasynciterator).

## Validation and contracts

`RequestValidationModule` registers the shared `createInputValidationPipe()` as Nest's global `ValidationPipe`. Requests use `class-validator` DTO decorators and `class-transformer` nested `@Type` metadata. Unknown fields, malformed nested objects, null required values, and non-string credentials are rejected. Transformation creates class instances and canonicalizes declared contact/email strings; implicit primitive conversion is disabled. Password whitespace and leading-zero codes are preserved. Public validation errors omit submitted values.

Untrusted non-HTTP payloads pass through `withValidatedInput` before a job/CLI/event adapter maps them into service inputs. Internal calls using already validated commands do not repeat validation. Services own business rules and assume validated input; they do not repeat required/type/length/format checks or contact normalization. Domain policies still enforce authorization, current product requirements, expiry, consent, financial invariants, and provider-evidence correlation. Swagger uses the DTO classes rather than a second set of request schemas. Environment configuration continues using Zod; it is independent of HTTP DTO validation. Responses are explicit safe projections, never serialized database records. Future wallet responses must map bigint minor units to integer strings.

HTTP failure formatting and redacted diagnostics are owned by the global `HttpExceptionFilter`, registered through `HttpErrorHandlingModule`. Feature filters extend that shared boundary to project business errors and preserve financial uncertainty. All errors use `{ statusCode, code, message, requestId }`, with optional retry guidance, server-generated request references, and no-store headers. See [HTTP error handling](error-handling.md) for status mapping, privacy, response recovery, and verification.

## Storage and durable work

Eligible reads use repository-owned cache-aside with normalized query parameters, authorized account scope, and explicit expiry. Updates invalidate affected details, collections, and summaries after commit. Define recovery for failed invalidation and protection against stale concurrent fills. Authentication and wallet authorization currently require immediate consistency and bypass cache.

A financial transaction binds participating repositories to the same Kysely transaction. Journal and outbox writes commit with the business change. Provider calls run outside long-lived database transactions, with durable progress and reconciliation. API, SMS, bulk, and schedule paths must share logical payment identities. The separately deployed worker runs BullMQ payment recovery using the shared `PaymentsRuntimeModule`; API replicas never consume jobs. PostgreSQL recovery rows commit atomically with payment holds, so the queue is a wake-up mechanism rather than a per-payment second commit. See [worker operations](../../worker/README.md). BullMQ execution is introduced with its actual workflow; it does not replace the database ledger or authorization.

ESLint allows storage imports in concrete repositories and data sources while prohibiting them in contracts, services, domain code, and HTTP adapters. It also prohibits nested `if` statements. Every named code unit documents its responsibility and important guarantees. See [stack practices](stack-practices.md), [the layout decision](decisions/0004-feature-module-layout.md), and the root `AGENTS.md`.

## Device authentication

`DeviceAuthenticationService` adds device-key enrollment and login to the authentication feature. `PostgresDeviceAuthenticationRepository` owns device records and signing challenges; its transaction callback binds the existing authentication repository to the same connection for session issuance. Both own SQL directly. Enrollment requires a recent primary session; device sessions cannot enroll more keys. See the [device authentication decision](decisions/0005-device-authentication.md) and [wire contract](../src/modules/authentication/device-login.md).

See [input validation boundaries](input-validation.md) for the audit decisions, non-HTTP wrapper, and test strategy.

Password recovery reuses the code lifecycle and direct SQL repository. Challenge/credential-version checks, password replacement and account-wide session/device revocation commit atomically. Shared account locks prevent pre-reset proofs from issuing surviving sessions. See [password recovery](../src/modules/authentication/password-recovery.md).
