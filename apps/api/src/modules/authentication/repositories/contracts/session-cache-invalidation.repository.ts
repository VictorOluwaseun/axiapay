/** Deliver committed session-cache invalidations; failed work remains durable without undoing a committed business change. */
export interface SessionCacheInvalidationRepository {
  /** Attempt committed delivery with a bounded caller wait; timed-out durable work continues under its recovery deadline. Never call inside a business transaction. */
  flush(): Promise<void>;
}
