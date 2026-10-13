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
- The technology and application structure draft linked below records the supporting stack, feature layout, Android layout, and naming proposals. Preserve its distinction between confirmed decisions and proposed choices; documentation alone does not authorize installation or application code changes.

## Naming conventions

- Choose names that describe responsibility, business meaning, or observable behaviour for applications, folders, files, types, functions, parameters, and variables. Prefer clarity over brevity.
- Use consistent domain terminology across Android, API, workers, documentation, and public contracts. Distinguish concepts such as a payment, provider attempt, ledger entry, and SMS delivery; do not give different concepts interchangeable names.
- Use nouns for entities and values, action phrases for use cases and functions, and readable predicates for booleans. Examples include `Wallet`, `reserveWalletFunds`, and `hasSufficientFunds`.
- Make units, scope, and state meaning explicit where they are not already clear from the type or context. Prefer names such as `amountMinorUnits`, `timeoutMs`, `paymentStatus`, and `smsDeliveryStatus` over ambiguous `amount`, `timeout`, or `status`.
- Avoid unexplained abbreviations, single-letter names outside narrow conventional contexts, numbered variants, and vague names such as `data`, `stuff`, `process`, `manager`, or `helper` when a precise name is available.
- Follow the selected language and framework naming conventions. Include architectural roles or concrete data sources in names when they clarify responsibility, such as `WalletRepository` and `WalletPostgresDataSource`.
- Keep names aligned with behaviour as code changes. A method name must not imply stronger guarantees than it provides, such as calling an SMS submission a successful payment.

## Repository pattern

- Define repository contracts at the domain or application boundary; implement them in the data or infrastructure layer.
- Repositories encapsulate relevant data access and source coordination. Keep transport DTOs and persistence models from leaking into domain or presentation contracts.
- Repository implementations coordinate data sources. PostgreSQL data sources execute Kysely queries, and cache data sources execute ioredis operations. Database and Redis clients stay out of use cases, application services, domain code, and delivery handlers.
- Application use cases own workflows and coordinate repositories and external service ports. Repository implementations must not become catch-all business services.
- Avoid generic repository frameworks or abstraction layers that have no demonstrated need.

## Caching and invalidation

- Use repository-owned cache-aside behaviour for eligible reads: look up the cache, query the database on a miss, then populate the cache with an explicit expiry. Apply this behaviour consistently across HTTP and worker callers.
- Derive cache identity from normalized effective query parameters and authorized user or account scope. Include filters, sorting, pagination, and other inputs that affect the result. Cache hits never replace authorization.
- Every relevant update, creation, or deletion must account for invalidating affected details, collections, and summaries after a successful database commit. Expiry is an additional safeguard, not a replacement for invalidation.
- Define recovery for failed invalidation and protection against concurrent reads repopulating stale results. The linked draft describes proposed durable delivery and versioning mechanisms; choose and verify a concrete protocol during implementation.
- Keep cache policy and data-source coordination in repository infrastructure. Spending authorization, reservations, and settlement use authoritative database state. Reads requiring immediate consistency must bypass the cache or use a verified consistency protocol.

## Use cases

- Use cases are required in Android, API, and worker application layers. Give each use case one clearly named business action or business query with explicit inputs, outputs, and errors.
- Android ViewModels invoke use cases for business operations rather than accessing repositories or data sources directly. Use-case results feed the existing unidirectional state-update flow.
- API handlers, scheduled jobs, and event or queue handlers invoke use cases rather than implementing business workflows themselves.
- Use cases orchestrate domain behaviour, repository contracts, and external service ports through injected dependencies. Keep reusable business invariants in domain models or policies and data access in repository implementations.
- Android use cases prepare, request, or observe operations; API and worker use cases enforce authoritative permissions, pricing, wallet, and settlement rules. Do not duplicate authoritative financial logic on the client.
- Keep use cases independent of Views, ViewModels, HTTP request or response types, database models, and concrete provider SDKs. Map those types at the appropriate boundary.
- Test meaningful use-case behaviour, including success, validation, authorization, and failure or recovery paths where relevant. Purely visual state changes do not require a business use case.

## Control flow

- No nested `if` statements.
- Prefer guard clauses, early returns, named predicates, flat exhaustive state handling, and small focused functions.
- Do not replace nested `if` statements with equally tangled nested switches, conditional expressions, or opaque boolean expressions merely to satisfy the syntax rule.
- Make invalid states, failure paths, and recovery behaviour explicit.

## Maintainability and DRY

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
- Repository documentation must describe data-source coordination, cache eligibility, invalidation, and transaction participation where applicable. Data-source documentation must state the storage or external system it accesses. Use-case documentation must describe the business action and its guarantees.
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
