# payments domain

Own entities, value objects, invariants, and business errors. Import no controller, service, use-case, storage, or framework code.

Implemented scope: service preparation, quoted purchase authorization, submission, reconciliation, settlement and issued proof retrieval. Reversals and cancellation execution require separate workflows.

Education beneficiary evidence, consented insurance eligibility, service proof and private document descriptors are separate from financial payment status. Insurance issuance requires matching policy evidence and never implies currently active coverage.
