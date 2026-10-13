# payments repositories

Keep framework-independent repository contracts in `contracts/`. Concrete implementations own storage access directly or coordinate optional data sources. They own transaction scope, eligible cache reads, and invalidation after committed writes. Extract a data source only when storage complexity, reuse, or multiple stores justify a distinct responsibility. Business workflows belong in services or justified extracted workflows.

Feature scope: Purchase authorization, provider attempts, reconciliation, settlement, and reversals.

Bill extensions persist immutable owner/product-scoped customer validation and complete projected fulfilment receipts. Quotes reference the saved recipient and share its expiry bound. Financial evidence and later receipt delivery remain separate append-only records; storing or reading tokens does not create another journal or external purchase. Receipt conflicts do not overwrite history.

`PostgresPaymentRepository` directly owns quote/instruction/evidence persistence and the quote-acceptance transaction. It joins committed wallet reservations for progress without copying mutable wallet status. Acceptance invokes application validation while quote/product rows are locked; it does no network I/O or ledger work. Reads bypass cache; final evidence is append-only and provider movement identities are unique. Reversals after fulfilled purchases are not implemented in this increment.

Education validation and insurance application reads are owner scoped and authoritative. Immutable preparation evidence binds the selected product and bounds quote expiry. Insurance application identity is also bound to at most one accepted payment across quotes. Private document descriptors are append-only; batch insertion is transactional and conflicting observations never overwrite an existing descriptor. Document reads share the payment projection statement and are exposed only after application authorization.

Bank-beneficiary snapshots are immutable and owner/product/bank scoped. Acceptance acquires an authoritative bank-profile lock and passes its mapped state to application validation. Bank success and mandatory recipient-credit proof share one transaction with deferred commit enforcement; any proof conflict or persistence failure rolls back the observation. Safe final bank failure classifications are immutable. All reads and writes borrow the shared lifecycle-managed pool; no bank cache is involved.
