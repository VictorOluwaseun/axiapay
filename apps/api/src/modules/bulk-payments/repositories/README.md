# bulk-payments repositories

Keep framework-independent repository contracts in `contracts/`. Concrete implementations own storage access directly or coordinate optional data sources. They own transaction scope, eligible cache reads, and invalidation after committed writes. Extract a data source only when storage complexity, reuse, or multiple stores justify a distinct responsibility. Business workflows belong in services or justified extracted workflows.

Feature scope: Batch admission, item identities, funding policies, progress, and eligible retries.
