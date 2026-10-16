<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# AxiaPay engineering rules

These rules govern implementation and changes in this workspace.

## Architecture

- Use Clean Architecture with explicit presentation or delivery, application, domain, and data or infrastructure boundaries.
- On Android, combine MVVM with MVI: the View renders state and emits user intents; the ViewModel coordinates intents, invokes application use cases, and exposes immutable UI state.
- Enforce unidirectional data flow (UDF): UI intents enter the ViewModel; processing and use-case results produce immutable state updates; state flows back to the View for rendering.
- Give each UI state a single owner and expose it read-only. Views must not mutate that state directly or use two-way bindings that bypass the intent and state-update flow.
- Keep state transitions explicit and predictable. Define delivery and consumption rules for transient UI effects so rendering or lifecycle changes cannot repeat a payment or other action.
- Keep business rules in the domain and application layers. Do not put payment rules in Views, ViewModels, API handlers, database adapters, or provider clients.
- Keep domain code independent of Android, UI frameworks, networking clients, database libraries, and external providers. Dependencies point toward domain abstractions.
- The API and workers follow Clean Architecture and the repository pattern. MVVM and MVI govern Android presentation; do not introduce UI-specific layers into API or worker modules.
- Inject dependencies explicitly. Keep feature responsibilities cohesive and avoid cyclic dependencies, service locators, and hidden mutable global state.

## Selected tools and application naming

- Kysely is the selected SQL query builder; ioredis is the selected Redis client.
- Use names that describe component responsibilities, such as `api`, `worker`, and `sms-gateway`. Avoid vague application names and catch-all helpers or services.
- Do not use `backend` in folder names, package names or code identifiers. Use responsibility-specific names such as `payments-runtime` for shared payment execution and `node-service` for the Node service lint policy.
- The technology and application structure draft linked below records the supporting stack, feature layout, Android layout, and naming proposals. Preserve its distinction between confirmed decisions and proposed choices; documentation alone does not authorize installation or application code changes.

## Stack usage and framework practices

- Make deliberate use of the selected stack's supported capabilities where they improve correctness, security, performance, or maintainability. Prefer established framework facilities over custom replacements. Keep each capability within the existing architecture and responsibility boundaries.
- Verify guidance against the installed versions and official documentation before adopting APIs or changing configuration. Check compatibility across integrations, pin application dependencies where appropriate, preserve the lockfile, and validate upgrades with relevant tests.
- Introduce additional dependencies, abstractions, caching, or background processing only for a concrete requirement. Measure performance before optimizing; using the stack fully means choosing its appropriate capabilities, not enabling every feature.

### Android (Kotlin and Jetpack Compose)

- Use Kotlin, Jetpack Compose, Material 3, coroutines, Flow, and supported Jetpack APIs deliberately for concrete feature needs. Check installed versions and current official guidance before changing APIs, dependencies, or configuration. Keep versions in the Gradle catalog and Compose dependencies aligned through the BOM; document compatibility decisions and verify upgrades.
- Preserve Clean Architecture, MVVM with MVI, UDF, repositories, and Android application use cases. Keep ViewModels focused on presentation coordination and use-case results. Use Hilt for Android dependency injection at the composition boundary. Keep dependencies explicit and introduce separate Gradle modules when ownership, reuse, or build isolation justifies them.
- Hilt is the required Android DI framework. Use `@HiltAndroidApp` on the Application, `@AndroidEntryPoint` on Android hosts, and `@HiltViewModel` with constructor injection on ViewModels. Retrieve ViewModels through their lifecycle owner using the Hilt-backed `ViewModelProvider`/`viewModels` APIs; do not manually instantiate them or keep parallel production ViewModel factories. Plain constructor assembly remains appropriate in isolated unit tests.
- Keep domain and application code independent of Hilt, Dagger and injection annotations. Provide their plain Kotlin classes through focused `@Module`/`@InstallIn` bindings in `di`; use `@Provides` for construction and `@Binds` for injectable implementations where appropriate. Use explicit qualifiers when multiple bindings have the same type. Do not put business rules in modules or use entry-point lookups as service locators.
- Choose Hilt scopes to match actual ownership. Current saved-state demo repositories and navigation stores belong to `ViewModelComponent` and use `@ViewModelScoped`; all operations for that owner must share its repository and `SavedStateHandle`. Do not promote them to application singletons. Use `@ApplicationContext` for platform adapters, avoid retaining Activities/Views, and preserve existing subscription cleanup and restoration behaviour.
- Select demo and non-demo implementations through flavor-specific Hilt modules. Keep dev, demo, staging and prod independently installable and preserve the demo bindings while real integrations replace non-demo bindings. Pin Hilt and KSP in the version catalog, keep Hilt runtime/compiler/plugin versions aligned, and use KSP with AGP's built-in Kotlin. Verify the generated graph, release builds, scope isolation, recreation and existing flows across flavors when changing DI.
- Expose immutable UI state through read-only `StateFlow` and collect it with `collectAsStateWithLifecycle`. Hoist application state and keep composables focused on rendering and emitting intents. Scope UI effects and callback cleanup to their lifecycle; keep Activity, View, and Context references out of ViewModels. Follow the [Android architecture guidance](https://developer.android.com/topic/architecture/recommendations) within these project boundaries.
- Make asynchronous application operations main-safe with suspending contracts. Use structured concurrency, an explicit scope owner, and injected dispatchers for blocking work. Propagate `CancellationException`, avoid `GlobalScope`, and release subscriptions and callbacks. Choose Flow sharing lifetimes deliberately; a UI subscription must not own durable payment execution. Follow the [Android coroutine guidance](https://developer.android.com/kotlin/coroutines/coroutines-best-practices).
- Model loading, progress, errors, and recovery explicitly. Prevent overlapping duplicate submissions with stable logical request IDs and an appropriate in-flight guard. Consume results only for their intended screen/request; late completion must preserve newer navigation and drafts. Recomposition, lifecycle collection, and restoration must never replay a payment. Cancellation or a timeout does not establish payment failure.
- Protect repository snapshots from mutation through shared backing collections. Keep transport and persistence models inside adapters, preserve failure context, and publish local changes only after successful atomic persistence. Keep authoritative wallet, pricing, authorization, and settlement decisions on the backend.
- Use `SavedStateHandle` for small restoration values such as identifiers and form/navigation state. The current saved-state demo session is not durable storage. When a feature needs persistence across app dismissal or reboot, evaluate [Room](https://developer.android.com/training/data-storage/room) for structured records and [DataStore](https://developer.android.com/topic/libraries/architecture/datastore) for suitable preferences. Keep storage behind repositories and test migrations and recovery. These are conditional adoption guidelines, not declarations that those libraries are already installed.
- For implemented durable, deferrable device work, prefer [WorkManager](https://developer.android.com/develop/background-work/background-tasks/persistent) with explicit constraints, unique work identity, bounded retries, and persisted progress. Workers invoke use cases. Keep accepted recurring payment execution authoritative on the server; device scheduling is not an exact-time or exactly-once spending guarantee. ViewModel jobs and connectivity callbacks must not replace a durable outbox.
- Preserve automatic offline greyscale and online colour restoration, the temporary connection override, drafts, pending requests, and established funding follow-up behaviour. Connectivity is a signal, not proof of backend availability. Reconnection alone must not submit or confirm a payment. Keep SMS transport distinct from payment outcomes and retain the same logical identity across SMS and online reconciliation. Keep SMS simulated until its real transport and security design is implemented.
- Keep dev, demo, staging, and prod independently installable with distinct app IDs. Share UI and domain contracts; select implementations at the flavor composition boundary. Preserve demo fixtures and simulations as other flavors gain real integrations. Never disguise a backend failure with demo data or scatter environment checks through Views and domain rules.
- Preserve the established visual design and readable typography. Use shared theme tokens and reusable components; support font scaling, compact and larger windows, system insets, meaningful semantics, TalkBack, and distinguishable focus/selection/disabled states in both palettes. Use resources for new user-facing copy and locale-aware presentation of dates and money. Apply [Compose accessibility guidance](https://developer.android.com/develop/ui/compose/accessibility).
- Measure before optimizing. Use stable item keys and appropriate lazy containers, keep expensive work out of composition, and apply state/effect APIs with correct lifetimes. Use Compose compiler reports, profiling, and targeted release benchmarks or Baseline Profiles when a measured feature needs them. Only mark types `Stable` or `Immutable` when their contracts actually hold. Follow [Compose performance guidance](https://developer.android.com/develop/ui/compose/performance).
- Keep credentials and sensitive payment details out of source, resources, saved UI snapshots, and diagnostics. When integrations are implemented, use appropriate platform-backed key protection, minimum required permissions, bounded network timeouts, and retries consistent with payment idempotency and uncertain-outcome reconciliation. Client validation improves usability; the server still authorizes each protected operation.
- Keep formatting, Android lint, architecture checks, meaningful unit tests, and flavor verification reproducible in Gradle and CI. Cover use-case/repository invariants, suspended ViewModel actions, cancellation, duplicate requests, late results, restoration, and offline recovery. Run relevant checks while iterating and `./gradlew verifyAllFlavors` for shared source or build changes; run affected device flows separately on an explicitly selected emulator. Verify accessibility and representative screen/font sizes for UI changes. Investigate failures without weakening assertions; restore device settings after tests and report actual verification and remaining limitations.

### NestJS

- Use cohesive feature modules, constructor injection, explicit provider tokens for interfaces, and focused services. Controllers map requests to feature operations; services own business workflows and extract a use case only when an independent workflow boundary is useful. Keep repository implementations and clients private to their owning modules. Use [Nest provider registration](https://docs.nestjs.com/fundamentals/custom-providers) to compose dependencies rather than constructing service graphs inside handlers.
- Validate request DTOs with `class-validator` and `class-transformer` through a shared [Nest ValidationPipe](https://docs.nestjs.com/techniques/validation). Validate nested objects, reject unknown fields, and apply explicit transformations. Never silently coerce passwords, one-time codes, account identifiers, or money. Non-HTTP adapters validate untrusted payloads through a shared wrapper before calling services; authoritative business policies remain in services and domain code.
- Use guards for authentication and boundary authorization, pipes for transport validation, interceptors for appropriate cross-cutting behaviour, and exception filters for consistent safe errors. Keep business permissions in services or justified extracted workflows and document HTTP contracts with OpenAPI without duplicating competing validation definitions.
- Use Nest configuration and lifecycle facilities for validated settings, connection ownership, graceful shutdown, and cleanup. Keep credentials out of responses and diagnostics. Test the real module composition as well as business behaviour.

### Next.js

- Use App Router conventions and [Server Components](https://nextjs.org/docs/app/getting-started/server-and-client-components) for suitable server rendering and data access. Limit Client Components to interactive or browser-dependent portions. Keep secrets and privileged dependencies in server-only code.
- Treat Route Handlers and Server Actions as exposed server entry points: validate input and enforce authentication and authorization for every protected operation. Call the authoritative API for payment and wallet operations; keep financial rules in the API's services and domain policies.
- Choose caching and revalidation explicitly for the installed Next.js version. Prevent shared caches from exposing private account data, and reconcile displayed state after mutations. Use loading, error, and accessibility conventions, plus framework image, font, and navigation facilities where they serve the feature.

### Kysely and PostgreSQL

- Keep Kysely queries in concrete repositories or optional PostgreSQL data sources behind framework-independent repository contracts. Maintain schema types from reviewed migrations, map persistence rows to domain contracts, and use parameterized values. Whitelist dynamic identifiers and sorting choices; never interpolate untrusted input into raw SQL.
- Use [Kysely transactions](https://kysely.dev/docs/examples/transactions/simple-transaction) to bind participating repository operations to one connection. Combine appropriate locking and isolation with database constraints for concurrent writes. Keep external provider calls outside database transactions and preserve rollback and retry semantics.
- Use bounded connection pools with explicit lifecycle ownership. Select needed columns, bound result sizes, avoid unnecessary repeated queries, and validate indexes and query plans against actual access patterns.

### ioredis

- Keep Redis access in concrete repositories or optional cache data sources, with repositories owning cache policy under the existing caching and invalidation rules. Configure [ioredis](https://github.com/redis/ioredis) timeouts, reconnect behaviour, and offline queuing for each client's role; cache requests must not wait indefinitely during an outage.
- Reuse managed connections, handle errors with redacted diagnostics, and close connections on shutdown. Use pipelining for suitable independent operations; when correctness requires atomic Redis operations, use an appropriate transaction or script. Pipelining alone does not provide atomicity.
- Separate evictable cache storage from durable queue storage. Redis must not become the authority for wallet balances, settlement, or spending authorization.

### BullMQ

- Model jobs as retryable work with stable logical identities. Keep handlers thin and invoke the same service operations used by other entry points. Make financial effects [idempotent](https://docs.bullmq.io/patterns/idempotent-jobs) in authoritative storage; queue deduplication alone does not guarantee exactly-once payment execution.
- When a committed database change must produce a job, use a transactional outbox or another verified durable handoff. Record recoverable business progress independently of transient worker state. Recheck schedule status, expiry, and authorization before executing delayed work.
- Configure bounded retries and backoff by failure type, suitable concurrency and provider limits, failed-job retention, monitoring, and graceful worker shutdown. Uncertain provider outcomes require reconciliation before another attempt. Keep job payloads minimal and exclude reusable credentials.
- Follow [BullMQ production guidance](https://docs.bullmq.io/guide/going-to-production) for persistent queue storage and `noeviction`. Configure producers to fail within a bounded time and workers to recover after reconnecting; test outages, duplicate execution, stalled work, and restart recovery.

## Naming conventions

- Choose names that describe responsibility, business meaning, or observable behaviour for applications, folders, files, types, functions, parameters, and variables. Prefer clarity over brevity.
- Use consistent domain terminology across Android, API, workers, documentation, and public contracts. Distinguish concepts such as a payment, provider attempt, ledger entry, and SMS delivery; do not give different concepts interchangeable names.
- Use nouns for entities and values, action phrases for use cases and functions, and readable predicates for booleans. Examples include `Wallet`, `reserveWalletFunds`, and `hasSufficientFunds`.
- Make units, scope, and state meaning explicit where they are not already clear from the type or context. Prefer names such as `amountMinorUnits`, `timeoutMs`, `paymentStatus`, and `smsDeliveryStatus` over ambiguous `amount`, `timeout`, or `status`.
- Avoid unexplained abbreviations, single-letter names outside narrow conventional contexts, numbered variants, and vague names such as `data`, `stuff`, `process`, `manager`, or `helper` when a precise name is available.
- Follow the selected language and framework naming conventions. Name components by their feature responsibility and architectural role, such as `WalletRepository` and `WalletDataSource`.
- Name repository contracts `{Feature}Repository`, such as `WalletRepository` or `DeviceAuthenticationRepository`. Name their concrete implementations `{Feature}RepositoryImpl`, such as `WalletRepositoryImpl` or `DeviceAuthenticationRepositoryImpl`; a repository implementation may coordinate more than one store.
- Name feature data sources `{Feature}DataSource`, such as `WalletDataSource`. Add a qualifier only when it identifies a distinct responsibility or behaviour that needs its own data source. Preserve separate domain concepts such as wallet and ledger; do not invent a combined domain name merely to name a persistence component.
- Avoid database or vendor prefixes in repository and feature data-source names solely because of their current storage technology. Document PostgreSQL, Redis, and other implementation details inside infrastructure code and documentation. Explicit technology names remain appropriate for dedicated technology adapters when they clarify the adapter's actual responsibility.
- Name infrastructure components by the mechanism and responsibility they own, such as `CacheInvalidationOutboxDelivery` for durable outbox delivery and `CacheInvalidationConnection` for the recovery pool's connection lifecycle.
- Keep filenames aligned with component names using the language's conventions. In TypeScript, use `wallet.repository.ts` for the contract in `repositories/contracts`, `wallet.repository.impl.ts` for its implementation, and `wallet.data-source.ts` for the data source. Do not introduce a new abstraction, split a component, or change its behaviour just to satisfy a naming pattern.
- Keep names aligned with behaviour as code changes. A method name must not imply stronger guarantees than it provides, such as calling an SMS submission a successful payment.

## Repository pattern

- Define repository contracts at the domain or application boundary; implement them in the data or infrastructure layer.
- Repositories encapsulate relevant data access and source coordination. Keep transport DTOs and persistence models from leaking into domain or presentation contracts.
- Feature persistence stays behind repository contracts. Concrete repositories may execute Kysely queries and ioredis operations directly or coordinate optional data sources. Database and Redis clients stay out of repository contracts, use cases, services, domain code, controllers, and job handlers.
- Extract a data source only for a distinct storage responsibility, substantial storage logic, reuse, or useful separation across multiple stores. Avoid one-to-one forwarding layers with no independent responsibility. Authentication owns SQL directly in its repository; wallets retain their PostgreSQL data source for ledger persistence and transaction coordination.
- Keep transaction ownership explicit in either layout: all participating operations share the transaction connection and commit or roll back together. Repositories borrow lifecycle-managed clients; they do not create a pool per operation.
- API and worker services own workflows and coordinate repositories and external service ports; extract use cases only where justified. Repository implementations must not become catch-all business services.
- Avoid generic repository frameworks or abstraction layers that have no demonstrated need.

## Caching and invalidation

- Use repository-owned cache-aside behaviour for eligible reads: look up the cache, query the database on a miss, then populate the cache with an explicit expiry. Apply this behaviour consistently across HTTP and worker callers.
- Derive cache identity from normalized effective query parameters and authorized user or account scope. Include filters, sorting, pagination, and other inputs that affect the result. Cache hits never replace authorization.
- Every relevant update, creation, or deletion must account for invalidating affected details, collections, and summaries after a successful database commit. Expiry is an additional safeguard, not a replacement for invalidation.
- Define recovery for failed invalidation and protection against concurrent reads repopulating stale results. The linked draft describes proposed durable delivery and versioning mechanisms; choose and verify a concrete protocol during implementation.
- Keep cache policy and data-source coordination in repository infrastructure. Distinguish cached display reads from authoritative financial operations through explicit repository methods and result contracts within the same feature. Spending authorization, reservations, and settlement use authoritative database state. Reads requiring immediate consistency must bypass the cache or use a verified consistency protocol.
- Keep invalidation delivery, retries, startup/reconnect recovery, and connection lifecycle in repositories and infrastructure. Feature services expose business operations; do not add cache-maintenance methods merely to forward infrastructure calls.

## Services and optional use cases

- API and worker services own business workflows by default. Controllers, scheduled jobs, and event or queue handlers call service operations with explicit inputs, outputs, and errors.
- A separate use-case class is optional. Extract one when a complex workflow has a clear independent responsibility, such as cross-feature coordination, several business stages, or its own recovery/state rules. Explain the benefit; do not create one class per endpoint or make extraction depend only on line count.
- Keep related operations in the existing cohesive feature service, using small named methods. A separate endpoint, display projection, read-only operation, or use of caching does not by itself justify another service. For example, current-wallet discovery belongs in `WalletService` through a repository contract.
- Extract a collaborating service when it owns an independent business workflow with meaningful invariants, lifecycle, authorization, or recovery rules, such as reservation capture/release in `WalletReservationService`. Reuse shared domain policies and focused collaborators; avoid both one-action service wrappers and oversized services.
- Keep reusable feature models, summary contracts, repository contracts, and services in the shared feature module when the API and workers use that feature. Compose HTTP, authentication, and cache adapters at their module boundaries. Different transport or cache requirements alone do not justify duplicate business services or dependencies from shared feature code on API code.
- Services and any extracted use cases coordinate domain behaviour, repository contracts, and external capability ports. Repositories own persistence directly or coordinate justified data sources. Keep HTTP types, database models, SQL/Redis clients, and concrete provider SDKs out of workflow code.
- Extracted use cases remain independent of Nest and transport types. Domain models and policies remain framework-independent. API and worker services enforce authoritative permissions, pricing, wallet, and settlement rules.
- Android keeps its existing MVVM/MVI/UDF agreement: ViewModels invoke application use cases for business operations, and results feed immutable state updates. Client workflows prepare, request, or observe operations without duplicating authoritative financial rules.
- Test meaningful service and workflow behaviour, including validation, authorization, concurrency, and failure/recovery paths where relevant. Purely visual state changes need no business use case.

## API module layout and stack conventions

- Name API feature folders `controllers`, `services`, and `repositories`; introduce `usecases` only for a justified extracted workflow; add `dtos`, `data-sources`, `domain`, and focused adapter folders as needed. Do not wrap API feature code in `application` or `delivery` directories. Clean Architecture describes dependency rules, not mandatory folder names.
- Controllers and job adapters call feature services. Services own cohesive workflows through repository and external capability contracts. Services never receive SQL, Redis, or HTTP request/response objects. A separate use-case layer is optional, not a required delegation step.
- Keep repository contracts framework-independent in `repositories/contracts`. Concrete repositories own storage access directly or coordinate optional data sources. Services and optional use cases depend on contracts, domain rules, and provider ports, never concrete storage implementations. Optional use cases must not depend on Nest-specific services.
- Use Nest modules, constructor injection, explicit provider tokens, and lifecycle hooks. Export feature services and guards; keep persistence providers private. Do not use combined resource containers or service locators.
- Validate HTTP requests with class-validator/class-transformer DTOs and a global Nest ValidationPipe. Reject unknown fields and invalid nested objects; disable implicit credential conversion. Preserve password whitespace and code leading zeros. Generate OpenAPI contracts from the DTOs. Keep Zod for environment configuration.
- Keep Kysely operations in concrete repositories or optional PostgreSQL data sources, with generated schema types, parameterized queries, explicit transactions, and bounded pools. Keep cache-aside and invalidation decisions in repositories; ioredis operations may live there or in optional cache data sources.
- Use BullMQ for implemented durable background workflows with stable logical IDs, idempotency, bounded retries/backoff, monitored failures, and graceful shutdown. Keep queue Redis persistent and separate from evictable cache Redis. Use an outbox when committed work must be dispatched reliably.
- Use Next.js App Router and Server Components for appropriate server rendering, with small Client Component boundaries for interaction. Keep secrets server-side and Nest authoritative for financial and authentication workflows. Do not duplicate payment rules or read payment tables directly from web code.
- Apply each stack capability where the current feature needs it; do not add placeholder workers, cache layers, or business endpoints merely because a library is installed.

## Input validation boundaries

- Validate untrusted input once at the boundary that owns its contract. Every additional check must protect a distinct trust boundary, business invariant, or changeable state; do not add defensive validation without a concrete reason.
- Prefer class-validator's existing decorators and functions over handwritten checks for standard boundary formats. Add a custom constraint only for contract requirements the built-in validator does not enforce; keep validation libraries out of domain code and services.
- Validate and normalize untrusted input before invoking workflow logic. HTTP request shape, required fields, types, lengths, enums, UUID/phone/email formats, fixed numeric bounds, pagination, and static cross-field constraints belong in DTOs and Nest pipes. Put explicit permitted transformations, such as contact canonicalization, in class-transformer DTO metadata or boundary mappers.
- Services consume typed, validated, normalized commands. Do not repeat DTO checks, parse transport input, normalize contacts, or import DTOs, pipes, class-validator, or class-transformer into services or optional use cases. Controllers map validated DTOs to service inputs; they do not implement parallel validation logic.
- Reuse validated values and constructed value objects. Serializers map prepared requests directly; do not parse and reformat the same amount, reconstruct valid Money, or repeat checks already completed by `toRequest` or another owning boundary.
- Non-HTTP adapters that receive untrusted job, event, CLI, or integration payloads must validate before calling services. Use the shared `withValidatedInput` wrapper and the appropriate DTO, or an equivalent adapter-specific schema, then map the result into the workflow command. Do not validate already trusted internal calls again merely because they bypass HTTP. A TypeScript type alone does not validate an external payload.
- Keep authoritative business rules in services/domain policies: credential verification, authorization, account/device state, current product requirements, consent, quote expiry, recipient correlation, funds, pricing, reservations, settlement, concurrency, and recovery. Domain value objects still protect financial invariants. Product-dependent required/allowed fields and rules involving stored state or current time are business decisions, not static DTO validation.
- Base provider response contracts and checks on official documentation and verified response examples. Do not invent response fields, require request-only fields in responses, or add unsupported aliases and fallbacks.
- Preserve cryptographic parsing and trusted-provider evidence verification at their capability/domain boundaries. A valid request shape never establishes payment success, key possession, provider evidence, or financial authorization. Do not remove those checks while eliminating duplicated request validation.
- Use one DTO definition and shared pipe configuration for each input contract; document input preconditions on service operations. Reject malformed boundary input before rate-limit consumption, repository/provider calls, hashing, queue publication, or other workflow side effects. Test rejection at the boundary and business behavior at the service/domain boundary.

## Control flow

- No nested `if` statements.
- Always use curly braces for `if`, `else`, and loop bodies, even when they contain a single statement.
- Prefer guard clauses, early returns, named predicates, flat exhaustive state handling, and small focused functions.
- Do not replace nested `if` statements with equally tangled nested switches, conditional expressions, or opaque boolean expressions merely to satisfy the syntax rule.
- Make invalid states, failure paths, and recovery behaviour explicit.

## Maintainability and DRY

- Prefer direct string operations, equality, range checks and date parsing for simple predicates. Use regular expressions only when they make a structured format clearer.
- Make code readable from top to bottom with descriptive names, clear intermediate values, and straightforward expressions. Avoid clever expressions, repeated conversions, and extra wrappers that obscure the business action. Extract a named predicate or function when it clarifies a real responsibility.
- No spaghetti code: keep functions, classes, ViewModels, handlers, and modules focused on a clear responsibility.
- Use meaningful names and explicit contracts. Avoid oversized coordinators, cross-layer shortcuts, and unrelated shared utility collections.
- Apply DRY to business rules and established shared behaviour. Extract abstractions when a real common responsibility exists; avoid premature generalization of superficially similar code.
- Keep authoritative pricing, permission, wallet, and settlement rules in the API and worker domain and application layers. Client validation improves usability but does not replace server validation.

## Engineering practices

- Use practices appropriate to the selected language and framework; verify current official guidance when choosing or changing technologies.
- Use explicit error models and preserve failure context. Do not swallow errors or turn uncertain provider outcomes into confirmed failures.
- Model money using integer minor units or a suitable exact decimal representation with explicit currency and rounding rules; do not use binary floating-point arithmetic for money.
- Preserve atomic money movements, safe concurrent reservations, idempotent logical requests, bounded retries, and durable progress for bulk and scheduled work.
- Enforce authorization at the server boundary and within the relevant business operation. Keep secrets and sensitive payment data out of logs and source code.
- Use structured, appropriately redacted diagnostics and traceable transaction references.
- Run formatting, static analysis, and meaningful checks appropriate to a change. Test business rules, state transitions, failure handling, concurrency, and financial invariants where affected; avoid tests that merely mirror implementation.
- Prefer the simplest maintainable design that meets the actual requirement. Do not equate more patterns or dependencies with better engineering.

## Code documentation

- Every authored module and named code unit must have concise code documentation describing its responsibility and boundaries. This includes classes, interfaces, functions and methods, use cases, repositories, data sources, controllers, ViewModels, and workers.
- Keep responsibility documentation beside the declaration using the language's documentation format, such as TSDoc/JSDoc for TypeScript or KDoc for Kotlin. Describe what the unit owns and what it delegates. A declaration comment can also serve as the file overview when it fully describes a single-unit file.
- Document contract details where applicable: input meaning and units, outputs, preconditions, errors, side effects, authorization expectations, state transitions, and important failure or recovery behaviour. Do not merely repeat parameter types or the declaration name.
- Repository documentation must describe direct storage access or data-source coordination, cache eligibility, invalidation, and transaction participation where applicable. Data-source documentation must state the storage or external system it accesses. Service and optional use-case documentation must describe the business action and its guarantees.
- Keep shared contract documentation at the interface or port. Implementations should reference that contract and document their own responsibilities and relevant differences, avoiding copied descriptions that can drift.
- Add inline comments where needed to explain non-obvious decisions, domain invariants, concurrency, idempotency, cache races, monetary calculations, provider uncertainty, or other important constraints. Explain why; do not narrate obvious statements or add filler comments.
- Keep documentation proportionate: a simple function may need only one precise sentence; complex financial or recovery behaviour needs enough detail to review safely. Documentation does not replace clear names, focused code, or meaningful tests.
- Update comments and responsibility descriptions in the same change as behaviour. Remove misleading or obsolete comments and commented-out code. Record significant architectural tradeoffs when decisions are made.

## Git branches

- Do not create, switch to, rename, or delete a Git branch unless the user explicitly requests that exact branch operation.
- Never invent a branch name. If the user requests a new branch without naming it, ask them for the name.
- Never add a `codex/` prefix to any branch name.

## Engineering reference

- [AxiaPay Technology Stack and Application Structure Draft](https://chatgpt.com/space/page_d527055d03a88191b1383b8d08883119) records selected Kysely and ioredis tools, the proposed supporting stack, `apps/api/` and feature layouts, Android layer layout, repository and data-source boundaries, cache identity and invalidation, transaction boundaries, and existing screen conventions.

## Product reference

- The MVP serves individuals only. Agent and business features remain future scope.
- [AxiaPay Individual MVP Specification Draft](https://chatgpt.com/space/page_9d42d84b06448191a7129d5deeecb916) records the individual feature inventory, workflows, state and recovery rules, screen requirements, use cases, and open release decisions.
- [AxiaPay Individual MVP User Stories Draft](https://chatgpt.com/space/page_f37cd1daa0448191bd9b28617060f66e) maps 62 draft stories and 186 acceptance criteria to the individual features, including SMS offline stories IND 051 through IND 062. Story inclusion does not confirm provider availability or the final launch cut.
- [AxiaPay Product Specification Draft](https://chatgpt.com/space/page_1748c53693008191b60fb7629b259b7d) records product scope, commercial decisions, proposed operating rules, and open questions.
- Preserve the distinction between confirmed decisions and proposed defaults when implementing from the specification.

## Existing UI reference

- Build on the existing UI shown in `previews/`. Main references include `home.png`, `payments.png`, `activity.png`, `recurring-plans.png`, `data-payment.png`, and `recurring-payment.png`; larger-text and compact previews are also available.
- The current primary navigation is Home, Payments, Activity, and Plans. Payment entry uses bottom sheets, and recurring-payment setup includes recurrence choices and upcoming dates.
- Preserve the existing deep green and mint palette, light backgrounds, pastel service icons, rounded cards, outlined icons, and prominent typography in online mode. Offline mode uses the confirmed readable greyscale presentation while retaining the existing layout and visual hierarchy.
- Previews establish appearance and visible controls. Demo balances and screenshots alone do not verify API functionality, live integrations, or interaction behaviour.

## Offline product direction

- The main offline payment flow uses SMS when the customer has no internet. All app-controlled colours, including menus, icons, cards, buttons, and status indicators, become grey while remaining readable and visually appealing. Enabled, disabled, selected, and focus states must remain distinguishable.
- Familiar service forms remain available for eligible offline payments. After explicit submission, an encoded request goes by SMS to an AxiaPay-operated gateway phone intended to remain powered and internet-connected. The phone watches for AxiaPay SMS, decodes the request, and forwards it to the API.
- The API and workers remain authoritative for request authorization, current terms, wallet funds, provider execution, settlement, and refunds. SMS transport evidence is not payment success, and the SMS sender number alone is not spending authorization.
- Retain local drafts, previously accepted server schedules, and existing funding follow-up rules. Reconcile SMS and online submissions under the same logical request identity to avoid duplicate payments.
- The confirmed direction does not settle the wire format, enrollment and security mechanism, SMS permissions and distribution, reply channel, service eligibility, or gateway operating limits. Follow the linked specification's distinction between confirmed requirements and proposed implementation rules.
