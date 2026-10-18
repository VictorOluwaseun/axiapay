# Firebase remote configuration

Firebase is the configuration administration source. The API validates a global policy from its **server template**, enforces it during authentication and new payment workflows, and publishes the effective settings through `GET /v1/config`. Android does not need a Firebase SDK for these shared settings.

## HTTP contract and versioning

A first request, or one carrying an old version, returns `200 OK` with `ETag: "rc1-<sha256>"` and `Cache-Control: private, no-cache, must-revalidate`:

```json
{
  "version": "rc1-<sha256>",
  "authentication": {
    "signup": {
      "emailEnabled": true,
      "phoneEnabled": true,
      "passwordEnabled": true,
      "otpEnabled": true
    },
    "login": {
      "emailEnabled": true,
      "phoneEnabled": true,
      "passwordEnabled": true,
      "otpEnabled": true
    }
  },
  "features": {
    "airtime": { "enabled": true },
    "data": { "enabled": true },
    "electricity": { "enabled": true },
    "tv": { "enabled": true },
    "education": { "enabled": true },
    "insurance": { "enabled": true },
    "bankTransfer": { "enabled": true },
    "merchant": { "enabled": true },
    "airtimeConversion": { "enabled": true }
  }
}
```

Compression proxies can return a weak ETag (`W/"rc1-…"`) for the same versioned settings. Native clients retain the exact received validator and use [weak comparison for GET revalidation](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.2); a different opaque version still fails validation.

Store the response and ETag together. On subsequent requests send the **quoted** ETag in `If-None-Match`:

```http
GET /v1/config
If-None-Match: "rc1-<sha256>"

HTTP/1.1 304 Not Modified
ETag: "rc1-<sha256>"
Cache-Control: private, no-cache, must-revalidate
```

A `304` body is empty: retain the stored settings instead of decoding JSON. An unknown or changed validator receives `200` with the complete configuration. Weak validators and ETag lists follow HTTP matching rules; a bare unquoted version does not match. Send no validator if the app has lost its cached body. Clients can retain the exact ETag or surround the JSON `version` with double quotes.

The opaque version identifies public configuration content using SHA-256 and a representation revision prefix (`rc1`). It is independent of the Android app version and Firebase template version. Each public flag change changes it. Identical settings across replicas yield identical versions. Descriptions, unrelated Firebase parameters and unchanged refreshes do not change it. Rolling back to identical content restores the prior version. Future public fields must participate in the digest; change the prefix when the representation's interpretation changes.

HTTP caches must revalidate a stored response before serving it. The native app separately retains a last-known settings projection for offline display, without treating it as a newly validated response or authentication authority. Errors remain `no-store`. The endpoint resolves a valid snapshot before comparing versions: absent or expired policy returns `503 REMOTE_CONFIG_UNAVAILABLE`, even with a matching ETag or wildcard validator.

## Firebase setup

1. Select a Firebase project for the API environment; use separate development, staging and production projects.
2. Enable the Firebase Remote Config API (`firebaseremoteconfig.googleapis.com`). On the console's Remote Config page select **Server**.
3. Publish the eight required authentication and nine payment BOOLEAN parameters below. The [starter server template](../../../config/firebase-remote-config.server.json) enables every listed switch. Importing replaces template contents, so merge these parameters into any existing template before publication.
4. Give the API identity Firebase Remote Config Viewer (`roles/cloudconfig.viewer`), which includes `cloudconfig.configs.get`. The API performs no Firebase writes.
5. Set `FIREBASE_PROJECT_ID` and arrange Google Application Default Credentials. For local development, `gcloud auth application-default login` supports an identity with project read access. For deployment, prefer an attached identity or Workload Identity Federation. A trusted credential file can be referenced through `GOOGLE_APPLICATION_CREDENTIALS`; keep it outside the repository and Android app.

| Firebase parameter             | Public setting                          | Applies to                                               |
| ------------------------------ | --------------------------------------- | -------------------------------------------------------- |
| `auth_signup_email_enabled`    | `authentication.signup.emailEnabled`    | Email signup requests and redemption                     |
| `auth_signup_phone_enabled`    | `authentication.signup.phoneEnabled`    | Phone signup requests and redemption                     |
| `auth_login_email_enabled`     | `authentication.login.emailEnabled`     | Email password login, login-code requests and redemption |
| `auth_login_phone_enabled`     | `authentication.login.phoneEnabled`     | Phone password login, login-code requests and redemption |
| `auth_signup_password_enabled` | `authentication.signup.passwordEnabled` | Password signup requests and verification                |
| `auth_signup_otp_enabled`      | `authentication.signup.otpEnabled`      | Passwordless signup requests and verification            |
| `auth_login_password_enabled`  | `authentication.login.passwordEnabled`  | Password login                                           |
| `auth_login_otp_enabled`       | `authentication.login.otpEnabled`       | Login-code requests and verification                     |

| Firebase parameter                   | Public setting                       |
| ------------------------------------ | ------------------------------------ |
| `feature_airtime_enabled`            | `features.airtime.enabled`           |
| `feature_data_enabled`               | `features.data.enabled`              |
| `feature_electricity_enabled`        | `features.electricity.enabled`       |
| `feature_tv_enabled`                 | `features.tv.enabled`                |
| `feature_education_enabled`          | `features.education.enabled`         |
| `feature_insurance_enabled`          | `features.insurance.enabled`         |
| `feature_bank_transfer_enabled`      | `features.bankTransfer.enabled`      |
| `feature_merchant_enabled`           | `features.merchant.enabled`          |
| `feature_airtime_conversion_enabled` | `features.airtimeConversion.enabled` |

Contact and credential switches combine: an operation needs one enabled contact and one enabled credential choice. The password and OTP switches apply to both email and phone independently of contact availability. `otpEnabled` controls the passwordless one-time-code option. Password signup always requires contact verification, even with `signup.otpEnabled: false`; its issued challenge is gated by `signup.passwordEnabled` during redemption. The API determines that original flow from the challenge's stored password hash, never from a client-supplied verification method. Disabling both credential choices makes the operation unavailable. Existing sessions, device authentication and password recovery retain their separate policies.

For rollout, merge the four new credential parameters into each existing **server** template before deploying the updated API. Start with explicit `true` values to preserve previous behavior, retain all existing parameter values, then disable choices as needed. The API requires all eight authentication parameters; missing or malformed credential policy rejects a refresh just like missing contact policy. New credential changes participate in the same content hash and ETag/304 contract. Older Android releases may still show a disabled choice, but API enforcement prevents it from being used.

Set an explicit default `true` or `false` on every parameter. The starter enables every listed switch, preserving previous availability once published. Missing authentication settings, malformed supplied values, wrong types, in-app defaults and conditional overrides reject the entire refresh. Absent payment parameters default to disabled, keeping existing authentication-only server templates usable during rollout. Missing values never silently enable a payment or authentication method. Unrelated parameters and conditions are excluded from the public contract. Both methods may be disabled for an operation.

The [documented REST API](https://firebase.google.com/docs/reference/remote-config/rest/v1/projects/getRemoteConfig) supports `name=projects/{projectId}/namespaces/firebase-server/remoteConfig`. The data source uses Google's authentication library with this API, bounded timeouts and cancellation. [Server templates](https://firebase.google.com/docs/remote-config/templates/server) are independent of client templates; Firebase currently marks [server Remote Config](https://firebase.google.com/docs/remote-config/server) as Preview. See the [IAM role reference](https://docs.cloud.google.com/iam/docs/roles-permissions/cloudconfig).

## Refresh and failure policy

| Environment setting                 | Default        | Meaning                                                        |
| ----------------------------------- | -------------- | -------------------------------------------------------------- |
| `FIREBASE_PROJECT_ID`               | Absent locally | Explicit project; required in production                       |
| `REMOTE_CONFIG_REFRESH_INTERVAL_MS` | `60000`        | Delay between completed refresh attempts                       |
| `REMOTE_CONFIG_FETCH_TIMEOUT_MS`    | `10000`        | Total allowed refresh duration, including credential discovery |
| `REMOTE_CONFIG_MAX_AGE_MS`          | `300000`       | Maximum age after successful validation                        |

Maximum age must allow a refresh interval plus fetch timeout. Each API replica starts a background fetch and refreshes independently. A successful refresh atomically replaces its immutable snapshot and renews validity, including when content is unchanged. Authentication and configuration requests read memory, without contacting Firebase or PostgreSQL for configuration. Concurrent refreshes coalesce. Shutdown clears timers and aborts active work; late completion cannot publish or overwrite a newer snapshot. Diagnostics exclude raw provider errors, credentials and tokens.

A failed refresh retains the last valid policy until maximum age, without renewing its age or enabling disabled methods. Cold start, absent setup or expired policy makes signup/login return `503 AUTHENTICATION_UNAVAILABLE` until a valid refresh succeeds. Local liveness remains available without Firebase setup; production validation requires a project ID. Existing sessions, device authentication and password recovery retain their separate policies.

Changes propagate on each replica's next successful refresh, not atomically across replicas. The API enforces its valid policy even if Android shows an older option. These flags govern availability, not account authorization or session revocation. A step that already captured policy may finish during a change. A valid code checked against a disabled method is rejected before consumption or account, wallet or session creation; it remains retryable if re-enabled before expiry.

## Android consumption

The Android app in the separate `axiapay-mobile` repository consumes configuration through a repository and application use case, with immutable ViewModel state and the existing UDF flow. It persists the body and version atomically, scoped to the normalized API environment. Cold start restores a valid saved snapshot before network IO; authentication entry and foregrounding trigger conditional background revalidation. A `200` replaces the snapshot after successful persistence; a `304` retains it. Offline restarts continue using the saved switches for display, including explicit disabled values. Missing, corrupt or foreign saved records use email signup/login with password or one-time code until a valid online policy is available. A failed refresh remains explicit and never clears a previously loaded saved policy or labels it newly validated. These client settings have no expiry-based authorization guarantee: the API independently enforces its bounded, current policy on every authentication operation. Client defaults are never persisted or assigned a remote version, and do not override the API's authentication policy. It renders enabled contact and credential choices, hides either selector when only one option is enabled, and shows explicit unavailability when no contact or no credential option remains. Saved contact-only snapshots retain their original contact policy and both previously available credential choices; a partially supplied new credential policy is rejected. Known disabled credential values persist through outages. Changing policy never changes an entered password or issued proof, or submits a replacement request automatically. On `403 AUTHENTICATION_METHOD_DISABLED`, it refreshes and lets the user choose again without automatically submitting another contact. The API still authorizes every operation. Demo configuration stays isolated through flavor-specific bindings.

## Historical SQL configuration and verification

Remote configuration has no PostgreSQL dependency, query or fallback. No new database migration or read grant is needed. Keep the already-applied `202610170016-remote-config.js` migration and generated schema entry as history; the table and its values remain unused and preserved. Do not delete applied migration files or alter migration records. Table cleanup can follow after Firebase cutover and rollback needs are settled.

Tests inject controlled policy fixtures that are never production fallbacks. Tests cover Firebase validation, all seventeen switches, issued proof, bounded retention, expiry, recovery, concurrent refresh, cancellation, late completion, safe failures and conditional HTTP responses. Live Firebase verification requires the project ID, published server template and credentials.

## Payment feature policy and rollout

Merge and publish the nine new feature parameters in the existing Firebase **server** template to make the intended features available. Older authentication-only server templates remain valid; absent feature keys default to disabled until publication. Preserve existing authentication values and unrelated parameters; the supplied starter template is an example, not a replacement command. Each enabled switch still requires an enabled product, a configured capable provider, valid authentication, recipient verification, pricing and sufficient funds. No database migration is needed. Policy changes become effective on each replica's next successful bounded refresh, rather than immediately across all processes.

A disabled service remains discoverable with `isSubmissionAvailable: false`. Its new quotes, recipient/eligibility verification and new payment acceptance fail with HTTP `403 FEATURE_DISABLED`. Policy is rechecked after quote review and inside the locked wallet reservation transaction before moving funds. The policy adapter reads only the local bounded configuration snapshot there; no Firebase network call runs under the database lock. If config is absent/expired, new payment writes fail with `503 PAYMENT_UNAVAILABLE`. Unavailability projections report false without hiding owned quote history.

Already reserved/submitted payments retain status, identical-key replay, receipts, reconciliation and worker recovery even if policy becomes disabled or expires. Accepted but unreserved instructions must still pass current policy before any new hold. Airtime conversion checks policy before fresh eligibility and locked acceptance; accepted conversion instructions and credit recovery remain available. Feature switches do not release funds, cancel accepted obligations, change provider outcomes or replay purchases. Wallet funding and wallet-to-wallet transfers retain their existing separate policies.

Android restores these flags with the existing atomic, API-scoped config cache before background ETag revalidation. Disabled services remain labeled and disabled in the home/payment grids; a refreshed disablement also blocks explicit review, meter verification and confirmation of an open live purchase without discarding its quote or payment references. Re-enabling never submits automatically. Saved progress/history remains accessible. Older auth-only snapshots preserve authentication choices and default every payment feature to unavailable; a partial or malformed new feature object rejects the replacement. Demo's flavor binding always supplies its independent enabled fixture. No Firebase SDK, Redis authority or new device storage dependency is introduced.
