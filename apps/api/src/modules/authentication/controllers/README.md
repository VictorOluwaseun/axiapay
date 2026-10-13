# authentication controllers

Map validated HTTP requests to feature service operations. Derive caller identity from trusted authentication. Keep business workflows and storage access out of handlers.

Feature scope: Verified contacts, password and one-time-code sign-in, sessions, and device enrollment.

`DeviceAuthenticationController` exposes enrollment, signed device login, active-device listing, and revocation with strict DTOs, safe errors, and OpenAPI metadata. Protected device routes use the existing guard; services recheck the relevant ownership and enrollment authority. See [the device contract](../device-login.md).
