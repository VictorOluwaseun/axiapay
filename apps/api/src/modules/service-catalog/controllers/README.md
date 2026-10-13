# service-catalog controllers

Map validated HTTP requests to feature service operations. Derive caller identity from trusted authentication. Keep business workflows and storage access out of handlers.

Feature scope: Supported services, available products and plans, and scoped catalogue reads.

The current protected HTTP adapter lives at `payments/controllers/service-catalog.controller.ts` and is composed with `PaymentsModule`. It combines catalogue discovery with first-party submission availability, using feature services only; no provider routing enters the public response.
