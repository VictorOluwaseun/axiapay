# Payment recovery

Recovery owns follow-up of already authorized service payments. `PaymentRecoveryService` calls the same `WalletPaymentService.reconcile` used by the API. Wallet capture/release still requires authenticated, correlated provider evidence. Queue delivery, retry exhaustion and a provider's missing-record response cannot authorize another purchase or establish a failed payment.

## Durable handoff and processing

Migration `202610150011-payment-recovery.js` creates `service_payment_recovery`. A storage trigger inserts one recovery record in the **same transaction** as a matching service-payment reservation. Failure rolls back both. Unfunded accepted payments create no recovery task. The migration also backfills matching existing unresolved holds without changing balances, journals, payment identities or submission claims.

The standalone `apps/worker` process owns `PaymentRecoveryWorker`, BullMQ 6 job schedulers and queue Redis connections. API replicas never consume recovery jobs. Both applications compose payment and wallet workflows from `@axiapay/payments-runtime`; the worker does not import or bootstrap the API. Every 15 seconds one global queue job claims a bounded PostgreSQL batch; the configured concurrency defaults to four checks. Jobs carry only `{ version: 1 }`. Payment IDs, owners, evidence and credentials are read from PostgreSQL, not queue input. Unknown fields and versions fail at the shared validation boundary before workflow calls.

PostgreSQL is the durable work list. Queue publication is not a second commit required for each hold. If Redis is unavailable or its jobs disappear, rows remain eligible; starting the enabled worker recreates the scheduler and scans due work. Bounded `FOR UPDATE SKIP LOCKED` statements issue unique two-minute leases. A stale completion cannot update a newer lease. Interrupted claims become eligible again after expiry. Automatic and lifetime attempt counts remain in PostgreSQL independently of queue retention.

Each task waits 30 seconds initially, then uses exponential backoff from 30 seconds, capped at one hour. After eight automatic checks it enters `needs_review`; repeated interrupted leases also consume that bounded budget. These are operational recovery defaults, not provider guarantees or financial failure deadlines. Queue-level retries separately cover batch/database failures. Other claims finish when one persistence operation fails.

An existing reservation without a submission claim can safely attempt its first dispatch through the existing one-time claim. A claimed payment uses status enquiry with the original reference. A crash immediately before versus after the provider accepts a request cannot always be distinguished automatically. An indefinitely unconfirmed result therefore reaches manual review with the hold intact.

## Enabling

Apply the migration before deploying the new query paths. The migration administrator must grant the ordinary payment permissions and run:

```sql
select grant_payment_recovery_runtime_access('your_runtime_role');
```

Configure `apps/worker/.env` with `DATABASE_URL`, `REDIS_QUEUE_URL` and the same VTpass environment, credentials and provisioned ledger accounts as the API. The worker needs no HTTP listener, authentication secret, Mailpit, cache or funding settings. Recovery defaults to enabled in this dedicated process; `PAYMENT_RECOVERY_ENABLED=false` disables its consumer. `PAYMENT_RECOVERY_CONCURRENCY` defaults to four and accepts integers from 1–100, bounding simultaneous recovery checks in each batch. Tests explicitly disable recovery unless exercising the consumer. Start it separately with `pnpm run dev:worker`, or build with `pnpm run build:worker` then run `pnpm --filter @axiapay/worker start`. Use a dedicated queue Redis instance with persistence and `maxmemory-policy=noeviction`, separate from evictable cache storage. BullMQ and ioredis belong to the worker package; shared workflows contain no queue consumer.

The producer fails within bounded connection/command deadlines; the consumer reconnects after outages. Failed-job retention and safe worker diagnostics are enabled. Worker shutdown drains in-flight checks before the database pool closes. All replicas use the same scheduler identity and global batch concurrency, while database leases remain the correctness boundary.

## Investigation and operator retry

`payment_recovery_needs_review` identifies escalation using only the payment ID and a controlled failure code. Recovery records retain status, attempts, next check and a safe failure code; raw exceptions, provider bodies, recipients, amounts and keys are not stored there. Monitor `needs_review` rows, including `RECOVERY_INTERRUPTED` rows created after repeated process exits:

```sql
select payment_id, recovery_status, automatic_attempts, total_attempts,
       last_failure_code, next_attempt_at, updated_at
from service_payment_recovery
where recovery_status = 'needs_review'
order by updated_at;
```

Investigate the original merchant reference with the provider. After investigation, a trusted operator on the deployment host can reopen bounded status checks:

```sh
pnpm --filter @axiapay/worker payments:retry-recovery <payment-uuid>
```

The command validates its input before opening clients, disables the background consumer for its own process and always closes the module graph. It reports whether an escalated task was reopened and preserves lifetime attempts. It cannot supply a financial outcome, change the owner, release funds, reset the submission claim or generate a new purchase identity. It is not a public HTTP endpoint. A provider that still cannot establish an outcome requires further investigation; this command does not resolve that uncertainty by itself.

## Scope and verification

This step implements recovery of existing service-payment holds and subsequent evidence/settlement follow-up. It does not implement bulk payment creation, recurring execution, notifications, provider webhook ingestion, an operator UI or manual financial adjudication. Existing provider registrations must remain available while they own unresolved obligations.

Tests cover real PostgreSQL holds and rollback, upgrade backfill, recovery before/after the submission claim, original-reference enquiries, conservative escalation, operator retry, concurrent/fenced leases, repeated process exits, real BullMQ/ioredis scheduling and restart after queue data loss. The implementation follows [BullMQ job schedulers](https://docs.bullmq.io/guide/job-schedulers/), [production connection guidance](https://docs.bullmq.io/guide/going-to-production), and [Nest lifecycle ordering](https://docs.nestjs.com/fundamentals/lifecycle-events).
