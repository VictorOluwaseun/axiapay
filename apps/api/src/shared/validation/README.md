# Input boundary validation

Own the shared Nest pipe configuration, reusable DTO constraints, and `withValidatedInput` wrapper for untrusted non-HTTP adapters. Validation and permitted transformations finish before workflow invocation. Import these units from DTOs, bootstrap, tests and entry-point adapters; services, optional use cases and domain code must not depend on this folder. See [the validation guide](../../../docs/input-validation.md).
