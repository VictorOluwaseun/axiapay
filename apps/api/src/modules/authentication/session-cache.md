# Session identity caching

`AuthenticationRepositoryImpl.findSessionIdentity` checks Redis first. A valid signed hit returns the public account identity with **zero PostgreSQL queries**. A miss loads the identity and session deadline from PostgreSQL, then conditionally fills Redis. Entries expire within 60 seconds and never outlive the session. Invalid sessions are not negatively cached. Credentials, codes, attempts and transaction-local reads bypass Redis; payment permissions, funds and settlement remain database-authoritative.

`AuthenticationGuard` allows cached identities for GET, HEAD and OPTIONS. Every other protected method requires current PostgreSQL session/account state before its handler executes, including wallet transfers, payment submissions and their recovery endpoints. A valid cached identity cannot authorize a protected mutation during a database outage or after committed revocation/disabling. Business services still enforce ownership, funds, pricing, consent and idempotency. Authorization is a request-time check; already authorized in-flight requests are not retroactively cancelled.

Payloads contain public identity, session/cache deadlines and generation markers. An HMAC binds each payload to its token digest. Malformed, expired, tampered or copied records behave as misses. Raw tokens, password hashes, codes and payment details never enter Redis. All API replicas must share the same Redis logical database and `AUTH_CODE_SECRET`. A database-owned namespace separates databases independently of connection URL spelling or credentials.

## Committed invalidation and recovery

Migration `202610160014-auth-session-cache-invalidation.js` records affected token digests in a PostgreSQL outbox through account/session mutation triggers. Account updates cover all its sessions; session updates/deletes cover the affected digests; truncation requests a namespace reset. Inserts need no invalidation because absent sessions are not cached. Outbox failure rolls back the mutation; transaction rollback publishes no invalidation.

Root authentication, device and code-redemption repositories attempt delivery after commit and await it for at most 250 ms. Timed-out delivery continues independently and pauses this instance's cache; it cannot turn a committed business change into a rollback or an indefinite response wait. Redis atomically deletes affected identities and rotates their generation markers. Acknowledgement deletes only the delivered outbox version, preserving newer changes to the same token. Failed delivery leaves durable work. Recovery runs at startup and every second, processing at most four batches of 256 entries per attempt. Startup/reconnect rotates the namespace epoch before enabling hits, including when the outbox is empty, so restored Redis data cannot revive acknowledged sessions. A connection generation prevents an older recovery attempt from enabling a newer connection.

`SessionCacheInvalidationConnection` owns a separate one-connection pool: acquisition is limited to 250 ms, server statements to 250 ms, server lock waits to 100 ms and client query waits to 500 ms. A one-second attempt deadline also bounds pooled query acquisition and batch progress. Server timeouts stop blocked SQL, and the dedicated pool keeps recovery from occupying business connections. Shutdown stops recovery before closing this pool. None of these timeout settings change business transactions or migrations.

A Redis lookup captures epoch and token generation before the database read. A fill succeeds only if both still match. Invalidation, marker eviction or namespace reset rejects an overlapping stale fill. Missing markers receive fresh random generations, avoiding reuse after eviction.

## Consistency and outages

PostgreSQL commit and Redis delivery are separate operations. Application mutations attempt invalidation before responding, but another replica's read-only request can observe an older entry between commit and delivery, or while delivery fails or is backlogged. Protected mutations bypass that cached state. Direct SQL changes are captured durably and delivered by the recovery poll. Expiry bounds each existing entry's lifetime; durable delivery and generation checks provide recovery and stale-fill protection. Transaction-bound credential/device workflows continue rechecking authority in their transactions.

Redis outages bypass the cache with bounded connection/command timeouts. A PostgreSQL outage causes misses and authoritative operations to fail; valid hits continue only until recovery detects it and pauses local cache use. Known invalidation failures also pause local hits. Distributed commit/delivery lag is not an immediate-revocation guarantee during failures.

## Rollout

Apply migration 0014 after 0013 before deploying this code. Drain older API replicas first: 0014 removes their read-time revision accessor. Grant the authentication runtime role `SELECT, DELETE ON public.auth_session_cache_invalidations`; trigger functions enqueue using narrowly scoped owner privileges and a fixed search path. Runtime roles cannot modify namespace metadata. Regenerate schema types after migration. No development database is migrated automatically.

Version 2 keys ignore older cache entries. Clear the cache namespace or change its stored namespace administratively when restoring a database backup against existing Redis data. Test recovery using disposable PostgreSQL/Redis containers; do not restore live credentials into tests.

Integration coverage includes independent Nest APIs, business/recovery pools and Redis clients, cross-instance revocation and stale-fill races, stale-read/current-write behavior during failed delivery, blocked SQL and exhausted recovery pools.
