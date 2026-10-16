# Authentication

The API supports signup and login with one phone number or email address per account. Signup always verifies contact ownership using a one-time code. Supply a password during signup to enable password login, or omit it for code-only access. Accounts with a password can also log in with a code.

Successful signup verification automatically provisions one active NGN wallet with zero available and reserved balances. Account activation, wallet and ledger-account creation, code consumption, and session issuance commit in one transaction. A storage failure rolls them all back, so the same signup proof can be retried while it remains valid. Signup requests and unsuccessful verification never create a wallet. Existing-account login does not provision or backfill wallets; `POST /v1/wallets` remains available to create or retrieve an owner/currency wallet without duplicates. This internal wallet does not provision a provider bank account or enable funding by itself.

Email identities are trimmed and lowercased without removing dots or plus aliases. Phone numbers require international format, for example `+2348012345678`. Forgotten passwords can be [reset with a phone/email code](password-recovery.md), including setting a first password on a verified code-only account. Linking another contact, authenticated password changes, lost-contact recovery, and payment authorization are separate workflows. The [device login API](device-login.md) now supports enrollment and signed-challenge login for Android fingerprint integration; Android biometric enforcement and hardware attestation remain separate work.

## Local setup

From the repository root, after copying `.env.example` to `apps/api/.env`:

```sh
pnpm --filter @axiapay/api auth:setup
pnpm --filter @axiapay/api build
pnpm --filter @axiapay/api db:migrate
pnpm run dev:api
```

`auth:setup` creates a persistent random `AUTH_CODE_SECRET` in the ignored local `.env` without printing it or replacing an existing key. Keep the key stable across restarts. It protects code digests and private rate-limit identifiers; changing it invalidates outstanding codes and changes rate-limit identities.

Local delivery uses Mailpit at <http://127.0.0.1:58025>. Email codes appear in that inbox. Phone codes appear as simulated SMS messages addressed to `sms+<international digits>@sms.axiapay.test`. Nothing is sent to an actual inbox or phone. Only loopback Mailpit endpoints are accepted, and production mode rejects this adapter. A production messaging provider must implement `AuthenticationCodeDelivery` before deployment.

## HTTP contract

All paths below are under `/v1/auth`. Authentication responses use `Cache-Control: no-store`. Codes, password hashes, and session digests are never returned by the API.

| Method and path           | Request                               | Success                                                                   |
| ------------------------- | ------------------------------------- | ------------------------------------------------------------------------- |
| `POST /signup`            | `contact`, optional `password`        | `202` challenge; the account is not active yet                            |
| `POST /signup/verify`     | `challengeId`, `code`                 | `201` verified account and bearer session; empty NGN wallet provisioned   |
| `POST /login/password`    | `contact`, `password`                 | `200` bearer session                                                      |
| `POST /login/code`        | `contact`                             | `202` challenge with the same contract for known and unknown contacts     |
| `POST /login/code/verify` | `challengeId`, `code`                 | `200` bearer session for an existing active account                       |
| `POST /password/forgot`   | `contact`                             | `202` purpose-bound reset challenge with a generic request contract       |
| `POST /password/reset`    | `challengeId`, `code`, `newPassword`  | `204`; password replaced, sessions and device keys revoked; sign in again |
| `GET /me`                 | `Authorization: Bearer <accessToken>` | `200` verified caller identity                                            |
| `POST /logout`            | `Authorization: Bearer <accessToken>` | `204`; repeat calls are safe                                              |

A contact has the form `{ "kind": "email", "value": "alice@example.com" }` or `{ "kind": "phone", "value": "+2348012345678" }`. Unknown body fields are rejected. A signup password must contain 15–128 Unicode characters; whitespace is preserved, and there are no uppercase, digit, or symbol requirements.

A challenge response contains `challengeId`, `expiresAt`, `expiresInSeconds`, and `resendAfterSeconds`. Read the code from Mailpit and submit it with the matching challenge ID. Signup, login and password-reset endpoints are purpose-specific; a code cannot cross between them. Recovery also binds the account and credential version at issuance; see [password recovery](password-recovery.md).

A successful authentication response contains `accessToken`, `tokenType: "Bearer"`, `expiresInSeconds`, and `account: { id, contact, verifiedAt }`. The token is opaque, not a JWT. Each login creates a new session with an absolute 24-hour expiry. Store it in protected client storage and use TLS outside local development. Logout commits revocation synchronously and attempts bounded cache invalidation; protected writes always recheck PostgreSQL, while read-only cache entries follow the documented recovery window; other device sessions continue until revoked or expired. There is no refresh-token endpoint in this implementation. Device login issues the same session format; logout retains its registration, while removing a device revokes sessions issued through that key. See [device session and recovery rules](device-login.md#session-and-recovery-behavior).

Example signup:

```sh
curl -X POST http://127.0.0.1:4000/v1/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"contact":{"kind":"email","value":"alice@example.com"},"password":"a longer private passphrase"}'
```

Omit `password` for code-only signup. After reading the corresponding Mailpit message:

```sh
curl -X POST http://127.0.0.1:4000/v1/auth/signup/verify \
  -H 'Content-Type: application/json' \
  -d '{"challengeId":"<challenge-id>","code":"<six-digit-code>"}'
```

## Security and recovery behaviour

- Codes contain six cryptographically random digits, expire after five minutes, and allow five failed guesses. The database stores a keyed digest bound to the challenge ID. Resending creates a new ID and invalidates the earlier code for that contact and purpose.
- Code delivery is limited to one request per contact per minute and five per hour across signup, login and password recovery, plus 30 requests per IP per ten minutes. Password login allows ten attempts per contact and 50 per IP per 15 minutes. Verification has a 100-attempt per-IP budget per 15 minutes as well as each challenge's five-guess limit. All counters are atomic PostgreSQL operations shared across API instances.
- `429` responses include `Retry-After`. Client IP comes from Fastify's direct connection identity; untrusted forwarding headers are not accepted. Deployment behind a proxy needs an explicit trusted-proxy policy.
- Passwords use salted Argon2id with 19 MiB memory, two iterations, and one lane. Unknown and passwordless accounts still perform a dummy password comparison. Incorrect credentials, expired/reused codes, unavailable accounts, and invalid sessions return the same `401` error contract.
- New signup cannot replace an existing account's password or merge accounts. A login code for an unknown contact never registers it. Verification failure after contact ownership is proven still uses the generic error response.
- Challenge locking serializes guesses and redemption. Failed guesses commit before returning failure. Account creation, the empty NGN wallet and both liability accounts, successful consumption, and session creation commit together. Storage failure rolls the operation back, allowing retry while the same code remains valid.
- Delivery is synchronous with a ten-second timeout. A challenge stays pending until provider acceptance, and a failure invalidates it. A process crash between sending and acknowledgement can leave an unusable pending code; request a new code after the cooldown. Lost successful verification responses require a fresh login rather than replaying the code.
- Sessions use random 256-bit tokens; PostgreSQL stores only their SHA-256 digests. Protected requests resolve session identity through [Redis cache-aside with committed invalidation](session-cache.md): read-only hits perform no SQL; protected mutations always check current session/account state in PostgreSQL, as do cache misses. Credentials, codes, attempts and transaction-local reads stay in PostgreSQL. The protocol documents the commit/delivery consistency window.
- Logs exclude credential payloads. Dependency failures retain a request reference and safe error classification, while public responses contain no provider or database details.

Production work still includes real delivery, breached-password screening, lost-contact recovery, durable password-change notifications, stronger authorization for money movement, expiry-data retention and cleanup, and operational abuse monitoring. A login session alone does not authorize offline SMS payments or prove account eligibility.

Existing verified accounts can receive their initial wallet through the explicit, retry-safe [wallet backfill command](wallet-backfill.md). It preserves existing funds, wallet identities and financial history.

## Responsibilities and verification

`controllers` map validated class DTOs to `AuthenticationService`. The service owns password login and session access and uses `AuthenticationCodeService` for code issuance, verification, activation, and atomic code-authorized password recovery. There is no mandatory use-case layer. `domain` owns credential state, expiry, authorization policy and the initial wallet currency. DTOs and input-boundary constraints own contact normalization, contact formats, and password/code length and shape. `repositories/contracts` defines authoritative persistence contracts. `AuthenticationRepositoryImpl` owns authentication SQL queries, persistence mapping, transaction scope and cache-aside policy; `RedisSessionIdentityCache` owns signed serialization and atomic generation checks. `PostgresSessionCacheInvalidationRepository` delivers committed outbox work with bounded caller waits and an isolated, time-limited recovery connection. `PostgresCodeRedemptionRepository` binds the authentication repository and existing wallet repository/data source to one transaction so signup cannot commit an account without its wallet. Services choose when to provision; each feature retains its SQL. Nested operations reuse the same transaction connection and transactional authentication reads bypass Redis. Root cache hits require no database query; see [the protocol, migration and outage behavior](session-cache.md). `AuthenticationModule` wires separate Nest providers and exports the service and guard. `DatabaseModule` owns the shared Kysely pool. Signup requires the wallet-ledger migration and runtime wallet-provisioning privileges as well as authentication-table access.

The global Nest `ValidationPipe` uses `class-validator` and `class-transformer`. Nested contacts are validated, unknown fields are rejected, and implicit primitive conversion is disabled. Passwords are never trimmed and one-time codes remain strings. Contact normalization runs before service entry. Password lengths count Unicode code points exactly; login length violations are `400 INVALID_INPUT`, while incorrect valid-shaped credentials remain `401 INVALID_CREDENTIALS`. Non-HTTP adapters use the shared `withValidatedInput` wrapper before calling the same operations. Swagger request and response schemas come from the DTO classes. See [the current layout](../../../docs/architecture.md).

Unit tests cover domain and credential policies. Integration tests exercise the public routes with real disposable PostgreSQL, including concurrency, failed-attempt persistence, replay, expiry, resends, rollback, revocation, and generic failures. A separate disposable Mailpit test checks email and simulated SMS capture. See [the authentication decision](../../../docs/decisions/0003-authentication.md).
