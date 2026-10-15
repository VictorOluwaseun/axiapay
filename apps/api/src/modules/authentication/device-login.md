# Fingerprint and device login API

The API now supports enrolling a device public key, signing in with that key, listing active registrations, and revoking a registration together with the sessions issued through it. It works with verified email or phone accounts, including accounts without a password. Signup and contact verification remain the existing password/one-time-code workflows.

The API verifies **registered-key possession**. Android must protect the private key with biometric authentication on every signing operation. No fingerprint image, template, device PIN, reusable password, or `fingerprintVerified` flag is accepted as device proof. Hardware key attestation is not implemented: this API does not certify that a client used Android Keystore, that a key is hardware-backed, or that a particular fingerprint was presented. Client-reported biometric success is not an authorization signal.

## HTTP contract

All routes are under `/v1/auth`, require TLS outside local development, and return `Cache-Control: no-store`. Use JSON request bodies; unknown fields and implicit credential conversion are rejected. The account is always resolved from the session or stored credential, never a supplied account ID.

| Method and path                      | Authorization                                                                  | Body / result                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `POST /devices/enrollment/challenge` | Bearer session from password or code authentication less than five minutes ago | `{ deviceName, publicKey }` → `200` signing challenge                               |
| `POST /devices/enrollment/verify`    | The same still-active, still-recent primary session                            | `{ challengeId, credentialId, signature }` → `201` device metadata                  |
| `POST /login/device/challenge`       | Public, rate limited                                                           | `{ credentialId }` → `200` signing challenge                                        |
| `POST /login/device/verify`          | Public, rate limited                                                           | `{ challengeId, credentialId, signature }` → `200` existing authentication response |
| `GET /devices`                       | Active bearer session                                                          | `200` array of the owner's active devices                                           |
| `DELETE /devices/:credentialId`      | Active bearer session for the owner                                            | `204`; unknown or foreign IDs have the same response and cause no changes           |

A recent signup verification or code login qualifies as primary authentication. A new device session does not qualify, even immediately after fingerprint login. To enroll another device, sign in with a password or one-time code again. Sessions that predate the migration still work for existing routes but require fresh primary authentication before enrollment.

Enrollment is opt-in on Android. A pending enrollment challenge creates no usable device credential. Completing enrollment requires proof from the proposed key and the exact primary session that initiated it. Device names contain 1–80 characters, must not start/end with whitespace, and cannot contain control characters. They are display labels, not trusted hardware identities. Up to five active credentials can be registered per account; concurrent enrollment cannot exceed this limit.

## Signing contract for Android

- Algorithm: ECDSA on P-256 (`secp256r1` / `prime256v1`), SHA-256.
- `publicKey`: unpadded base64url of the ASN.1 DER **SubjectPublicKeyInfo** public key. Android's `PublicKey.getEncoded()` supplies this representation. PEM, private keys, other curves, and noncanonical base64url are rejected. Maximum encoded length: 256 characters.
- `signature`: unpadded base64url of an ASN.1 DER ECDSA signature. Use Android/Java `SHA256withECDSA`. Raw IEEE-P1363 signatures, such as the 64-byte concatenation used by some JWT/WebCrypto integrations, are not accepted. Maximum encoded length: 128 characters.
- `message`: base64url of the exact bytes to sign. Decode it and sign those bytes unchanged. Do not sign the base64url text, hash it separately, reconstruct JSON, or change whitespace.

The signing challenge response is:

```json
{
  "challengeId": "server-issued-uuid",
  "credentialId": "server-issued-device-uuid",
  "message": "base64url-encoded-signing-bytes",
  "algorithm": "ECDSA_P256_SHA256_DER",
  "expiresAt": "2030-01-01T00:02:00.000Z",
  "expiresInSeconds": 120
}
```

Identifiers and message values above are placeholders. A new login request uses the credential ID returned by successful enrollment. Store that ID with the key alias for the specific AxiaPay account and environment; an OS installation ID or advertising ID is not used as a credential.

For protocol inspection, the decoded bytes are UTF-8 JSON of this ordered array:

```text
["axiapay-device-auth-v1", "enroll" | "login", challengeId, credentialId, nonce, expiresAt]
```

The nonce contains 256 bits of cryptographic randomness. The server stores the exact message alongside its purpose, credential, account, and (for enrollment) initiating session and proposed public key. Verification uses only those stored bindings. The enrollment and login endpoints cannot redeem each other's challenges.

On Android, generate the key in Android Keystore, require strong biometric authorization for each use, and sign through `BiometricPrompt.CryptoObject(Signature)`. Configure biometric-enrollment invalidation and handle a permanently invalidated or missing key by returning to password/code sign-in and enrolling a new key. The OS controls accepted biometric modalities and matching; supported strong biometrics can include fingerprint. Keep password/code sign-in available as the account-level fallback. See [Android biometric cryptography](https://developer.android.com/identity/sign-in/biometric-auth), [Keystore](https://developer.android.com/privacy-and-security/keystore), and [key attestation](https://developer.android.com/privacy-and-security/security-key-attestation) for the remaining client and stronger device-assurance work. Server signature handling uses [Node.js crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoverifyalgorithm-data-key-signature-callback).

## Session and recovery behavior

Successful device login returns the existing `{ accessToken, tokenType: "Bearer", expiresInSeconds: 86400, account }` response. Only the token digest is stored. The session records its credential ID and does not receive a primary-authentication timestamp. Existing bearer guards and account-disable checks continue to apply.

- **Logout:** revokes the presented session. The registered key stays available for another explicit device login.
- **Session expiry:** a fresh signed challenge can obtain another 24-hour session while the account and key remain active. No refresh token is introduced.
- **Remove a device:** permanently revokes that credential, consumes its outstanding challenges, and revokes all sessions created through that key in one transaction. A concurrent login either completes before revocation and is revoked, or sees the revoked key and fails.
- **Revocation scope:** credentials identify registered keys, not every session on a physical phone. Password/code sessions are not automatically associated with a device key and are not revoked by this endpoint. Full account/session recovery is separate work.
- **New phone, reinstall, or invalidated key:** normal phone/email sign-in followed by explicit enrollment with new key material. An existing or revoked public key cannot be registered again, including under another account.
- **Missing/late response:** enrollment and login proofs are single use. If enrollment may have completed, check the owner's active-device list. If a login response is lost, request and sign a fresh challenge. Do not retry a consumed proof expecting the original raw bearer token to be returned.
- **Storage failure before commit:** enrollment/session creation and challenge consumption roll back together. The same proof remains retryable until its deadline if the transaction did not commit.
- **Offline:** these endpoints require network access. Local biometric unlocking and SMS payment authorization remain separate Android/payment workflows. Device login signatures do not authorize payments.

Device metadata contains only `credentialId`, `deviceName`, `createdAt`, and nullable `lastUsedAt`. Revoked registrations are omitted from the list; retained key fingerprints prevent reuse.

## Expiry, limits, and safe failures

Challenges expire after two minutes. At most five failed signatures may be submitted per challenge; failed-attempt counters commit even when the HTTP response is an error. Successful proof consumption and session creation are atomic. PostgreSQL row locks protect against concurrent replay; cache and queue state are not authentication authority.

| Operation                | Shared database budget                                    |
| ------------------------ | --------------------------------------------------------- |
| Enrollment requests      | 20 per IP and 10 per account every 10 minutes             |
| Login challenge requests | 60 per IP and 30 per credential ID every 10 minutes       |
| Proof verification       | 100 per IP every 15 minutes, plus the per-challenge limit |

Unknown and revoked credential IDs get the same challenge response shape; verification gives a generic `401 INVALID_CREDENTIALS`. Counters use digests of rate-limit identifiers, and challenge issuance remains bounded for unknown IDs. Exact timing equality is not guaranteed.

| Status / code                        | Client response                                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `400 INVALID_INPUT`                  | Correct malformed IDs, names, encodings, unsupported keys, or unexpected fields.                      |
| `401 INVALID_CREDENTIALS`            | Treat the session/proof as unusable; retry through an appropriate fresh challenge or primary sign-in. |
| `403 RECENT_AUTHENTICATION_REQUIRED` | Sign in with password/code, then restart enrollment.                                                  |
| `409 DEVICE_LIMIT_REACHED`           | Remove an owned registration and retry enrollment.                                                    |
| `409 DEVICE_ALREADY_REGISTERED`      | Generate a new key; existing or revoked key material cannot be re-enrolled.                           |
| `429 RATE_LIMITED`                   | Respect `Retry-After`.                                                                                |
| `503 AUTHENTICATION_UNAVAILABLE`     | Preserve the operation state and retry or reconcile; success has not been confirmed.                  |

Do not log raw bearer tokens, signatures, or request bodies. The existing request serializer omits bodies; public failures expose no SQL or cryptography diagnostics. Deployment must configure trusted proxy handling deliberately before using forwarded addresses for per-IP limits.

## Persistence and rollout

`202610130003-device-authentication.js` adds `auth_device_credentials`, `auth_device_challenges`, and the nullable `device_credential_id` / `primary_authenticated_at` session columns. It preserves existing accounts and sessions and does not run at API startup. Regenerate reviewed schema types from the full migration chain; no additional package is required.

```sh
pnpm --filter @axiapay/api build
pnpm --filter @axiapay/api db:migrate
pnpm --filter @axiapay/api db:types:verify
```

Apply migrations before deploying the new API queries. Grant the application's authentication database role access to the two new tables, alongside its existing authentication privileges. Do not give wallet runtime code permission to alter financial history. For deployments using one runtime role for the API, that role needs both authentication and wallet permissions.

Expire-only challenge rows can be purged after a reviewed retention period, once no redemption transaction is in flight. Keep revoked credential tombstones while dependent sessions or the no-key-reuse policy require them. No cleanup worker or attestation verifier is installed by this increment; those must be separately designed before production rollout. Existing local Mailpit restrictions still apply to primary login.

## Ownership and verification

`DeviceAuthenticationService` owns enrollment, login, listing, and revocation. `DeviceAuthenticationRepository` and `AuthenticationRepository` share a transaction connection for atomic device and session work; both implementations execute Kysely directly. `NodeDeviceSignatures` owns strict key parsing and signature verification behind `DeviceSignatures`. DTOs/pipes validate names, identifiers, encodings, and lengths before controller-to-service mapping. Non-HTTP adapters use `withValidatedInput` with the same DTOs. Services enforce recent-primary authority, stored challenge/device bindings, expiry, revocation, and ownership; the crypto capability parses actual public keys and verifies proof. No separate use-case or data-source layer is added.

The integration tests exercise real Nest composition and disposable PostgreSQL with generated signing keys: phone/email and passwordless accounts, primary freshness, exact-session enrollment binding, purpose/device/account substitution, wrong-signature budgets, expiry, concurrent replay, enrollment limits, revocation races, disabled accounts, rollback, recovery, and OpenAPI contracts. Crypto tests cover DER interoperability and malformed/unsupported keys. They verify the API protocol, not a real fingerprint sensor or Android Keystore implementation.
