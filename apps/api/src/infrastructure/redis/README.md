# Responsibilities

Own ioredis connection configuration and lifecycle. Feature data sources own cache operations. Queue connections are separate from evictable cache connections.

`RedisCacheConnection` manages feature cache connections. It connects without blocking startup, bounds connection/command timeouts at 150 ms, disables offline queuing and command replay, backs off reconnects, reports controlled outage events and disconnects on module shutdown. Feature cache data sources treat unavailable connections as misses. Authentication and wallet summaries share the atomic generation scripts and reconnect recovery state, while each feature owns its signed payload format and cache-aside policy. Wallet summaries use a separate database namespace and signing domain; see [their protocol](../../modules/wallets/wallet-summary-cache.md). See the [session identity protocol](../../modules/authentication/session-cache.md) for authorization consistency and fallback behavior.
