# Authentication repositories

`contracts/authentication.repository.ts` defines the framework-independent persistence boundary. `PostgresAuthenticationRepository` implements it directly with Kysely queries and persistence-to-domain mapping. `authentication-database.ts` selects this feature's tables from the generated schema; those persistence types do not escape into the contract or services. Authentication does not need a separate data-source class.

`DatabaseModule` owns the shared pool. The repository borrows the connection and binds transaction callbacks to one connection, reusing an existing transaction for nested operations. Challenge replacement is atomic; code verification can commit failed-attempt counters or atomically consume a code, create an account, and issue a session. Credential and authorization workflows remain in services.

All reads use authoritative PostgreSQL state. Sessions, account status, challenges, and attempt limits bypass cache, so no Redis invalidation is required. A future data source should have a distinct storage responsibility rather than mirror the repository method for method.
