# bulk-payments infrastructure

Implement repository and provider contracts. Repositories coordinate data sources and cache invalidation; data sources execute Kysely or ioredis operations.

Feature scope: Batch admission, item identities, funding policies, progress, and eligible retries.
