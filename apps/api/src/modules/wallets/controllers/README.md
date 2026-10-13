# Wallet controllers

`WalletModule.register({ funding, paymentOutcome })` exports `WalletService` for authenticated API and worker adapters. No wallet HTTP routes are registered yet.

Future controllers must derive `actorId` from a verified session, validate DTOs, enforce the applicable payment authorization contract, and serialize bigint amounts as integer strings. Funding and settlement require trusted verification ports; customer-supplied success flags are never evidence. Controllers call the service and do not implement posting rules. See the [wallet module contract](../README.md).
