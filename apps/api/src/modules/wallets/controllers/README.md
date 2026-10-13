# Wallet controllers

`WalletHttpModule` registers the customer controller with `AuthenticationGuard` and the core `WalletModule`. `ApiModule` includes this HTTP composition; workers can import the core without the authentication or HTTP modules.

Routes create an owner/currency wallet, read its authoritative balance, and submit an internal transfer. The controller derives `actorId` from the guard's verified account, validates DTOs, canonicalizes UUID case, and serializes bigint amounts as integer strings. Services check ownership and financial rules again. The controller exposes no funding, reservation, or settlement operations. See the [route contract and examples](../README.md#customer-http-api).

Both success responses and controller/guard errors use `Cache-Control: no-store`. Inaccessible and nonexistent wallets share a 404 response. Domain conflicts have stable codes; dependency failures return a redacted 503 that directs clients to retry transfers with the original logical request key and terms. A 503 does not establish whether a transfer committed.
