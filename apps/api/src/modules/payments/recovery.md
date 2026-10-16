# Payment recovery

The separate [worker application](../../../../worker/README.md) owns BullMQ consumers and scheduling. API replicas only serve requests. Both use the same payment and wallet workflows from `packages/backend`.

See the [recovery operations guide](../../../../worker/docs/payment-recovery.md) for leases, backoff, escalation, configuration and operator retry. Database migrations remain in `apps/api/migrations`.
