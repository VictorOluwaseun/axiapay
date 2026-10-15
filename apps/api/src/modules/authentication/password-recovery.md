# Password recovery

The individual API supports forgotten-password recovery through the account's existing verified phone number or email. Each account currently has one contact; this flow cannot link another address, change the contact, create an account, or authorize a payment. Verified code-only accounts may use it to establish their first password.

## Client flow and HTTP contract

All paths below are under `/v1/auth`. No bearer token is needed. Responses disable caching. Input DTOs and the shared Nest validation pipe reject unknown fields, invalid nested contacts, malformed IDs/codes, and invalid password lengths before the service runs. Non-HTTP entry points use `withValidatedInput` with these same DTOs.

1. Submit `POST /password/forgot` with `{"contact":{"kind":"email","value":"alice@example.com"}}` or `{"contact":{"kind":"phone","value":"+2348012345678"}}`.
2. The `202` response contains `challengeId`, `expiresAt`, `expiresInSeconds`, and `resendAfterSeconds`, matching signup/login code requests. Display neutral copy such as “Check your phone or email for a code.” Do not infer registration status from this response.
3. Collect the six-digit code and the replacement passphrase. The UI can ask the user to enter the passphrase twice; submit one `newPassword` after matching them locally. Preserve leading zeros and all password whitespace.
4. Submit `POST /password/reset` with `{"challengeId":"<server UUID>","code":"012345","newPassword":"a replacement private passphrase"}`. The code and new password are submitted together; there is no intermediate reset token or general-purpose verified session.
5. `204` with an empty body confirms the password change. Clear stored sessions and device-key registrations, then return to normal sign-in. The response never contains a new session. Fingerprint login requires fresh primary sign-in and enrollment of a newly generated key.

Email canonicalization and international phone format match signup/login. New passwords require 15–128 Unicode code points, using the same policy as signup; whitespace is preserved and no implicit conversion is allowed. No composition rules are added.

| Result                                                    | Client recovery                                                                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `400 INVALID_INPUT`                                       | Correct the request. The workflow did not consume an attempt or change credentials.                                                         |
| `401 INVALID_CREDENTIALS`                                 | Code, purpose, identity, version, state, expiry or attempts are unusable. Request a new reset after the cooldown.                           |
| `429 RATE_LIMITED`                                        | Respect `Retry-After`; delivery budgets are shared across signup, login and recovery.                                                       |
| `503 DELIVERY_UNAVAILABLE` on request                     | Delivery was rejected or uncertain; that challenge is invalidated and no challenge ID is returned.                                          |
| `503 AUTHENTICATION_UNAVAILABLE` or a lost reset response | Success is unconfirmed. Try normal sign-in with the intended new password; otherwise request a fresh code. A used reset cannot be replayed. |

Local delivery remains Mailpit only: email codes appear at `http://127.0.0.1:58025`; phone codes are simulated SMS sent to `sms+<international digits>@sms.axiapay.test` in that inbox. No real SMS or email provider is enabled. `password-reset` is recorded as the delivery purpose. Codes never appear in the HTTP response or application diagnostics.

## Authorization and atomicity

The six-digit random code expires after five minutes and permits five wrong guesses. PostgreSQL stores an HMAC digest bound to its random challenge ID, not the code. Each challenge is also bound to its purpose and the existing account ID/credential version. Known, unknown and disabled contacts take the same request/storage/delivery path and return the same public shape. Unknown/disabled contacts get no usable account binding. Exact timing equality is not guaranteed; local delivery is still bounded and rate-limited.

Resending creates a new challenge ID and supersedes only the previous code for the same contact/purpose. Shared limits remain one delivery per contact per minute, five per contact per hour, and 30 per IP per ten minutes. Verification also uses the shared 100-per-IP budget per 15 minutes. Wrong guesses commit before a generic error is returned. A valid reset code cannot log in or sign up; signup/login codes cannot reset a password. A code issued before registration cannot become valid after that contact signs up.

A reset request alone never changes account access. Successful reset locks the challenge and then the account, verifies current identity/version/state, hashes the validated new password with the existing Argon2id capability, and rechecks expiry after hashing. One transaction consumes the code, replaces the password, increments the credential version, revokes every existing bearer session, and revokes all fingerprint/device-key registrations. Other accounts and all wallets/payments remain unchanged. Failure rolls back these writes together; a still-valid code remains retryable after a rolled-back transaction.

Credential versions also reject outstanding login/recovery proofs captured before reset, including proofs issued while reset was in progress. Session insertion checks the exact version while holding a shared account row lock, using [PostgreSQL 18 row-lock semantics](https://www.postgresql.org/docs/18/explicit-locking.html#LOCKING-ROWS). An in-flight password/code login either commits before reset and its session is revoked, or is rejected after reset. Device login and enrollment acquire the account before device/session locks; they serialize with recovery without reversing the lock order. Pending enrollment loses its session authority and pending device login loses its active key. Revoked key fingerprints remain tombstones; reenrollment needs a new key.

These choices follow the single-use, expiry, generic-request and session-invalidation principles in [OWASP's forgot-password guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html). This feature proves access to the existing contact, not financial identity, safe control after SIM swap/inbox compromise, or MFA recovery. Production still needs real messaging, breached-password screening, a durable password-change notification, retention/abuse monitoring, and a separate process for loss or compromise of the registered contact.

## Ownership, migration and verification

The controller maps `RequestPasswordResetDto` and `ResetPasswordDto` to `AuthenticationService`. The facade fixes the purpose and delegates the cohesive code lifecycle to `AuthenticationCodeService`. Services receive validated canonical commands and enforce stored-state/expiry/ownership policy; they do not import DTOs or repeat transport validation. The repository owns Kysely storage, version checks, transaction participation and access revocation without caching. No new dependency, worker, use-case layer, data source or Redis authority is introduced.

Apply `202610150010-password-recovery.js` before deploying these queries:

```sh
pnpm --filter @axiapay/api build
pnpm --filter @axiapay/api db:migrate
pnpm --filter @axiapay/api db:types:verify
```

The forward migration adds version columns and challenge account bindings, expands the allowed purpose, and backfills existing login codes only when the account predates issuance. It preserves accounts, password hashes, existing sessions, signup challenges and valid existing login challenges. It does not run at startup or change financial tables. Existing authentication table privileges are sufficient; no table or runtime grant is added. Roll forward rather than dropping recovery state after deployment.

HTTP/PostgreSQL tests cover email/phone recovery, code-only accounts, generic request contracts, purpose separation, stale/unknown/disabled identities, expiry, guessing limits, delivery failure, resends, replay, concurrent reset, late password login, pre-reset login codes, device invalidation, rollback and login/reset races. Boundary tests prove malformed input never reaches services, preserve Unicode/whitespace and leading zeros, and check OpenAPI contracts. Migration tests preserve pre-existing authentication records and check new storage constraints.
