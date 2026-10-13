# Health

`HealthController` invokes `HealthService`, which answers the liveness query directly. `/health/live` confirms process liveness without opening a database or Redis connection. It does not claim dependency or provider readiness. No repository is required for this query.
