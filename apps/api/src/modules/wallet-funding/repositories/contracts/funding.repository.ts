import type { FundingRequest } from '../../domain/funding.js';

/** Funding persistence uses authoritative PostgreSQL only; no cache is eligible and no invalidation is needed. */
export interface FundingRepository {
  /** Persist immutable terms or return an identical owner/request-key replay; conflicts must not alter the original. */
  create(
    request: Omit<
      FundingRequest,
      | 'initializationStartedAt'
      | 'checkoutUrl'
      | 'externalMovementId'
      | 'operationId'
    >,
  ): Promise<FundingRequest>;
  /** Read intent and the committed ledger receipt in one snapshot; return null for absent references. */
  get(id: string): Promise<FundingRequest | null>;
  /** Resolve an owner-scoped logical request before applying current routing configuration; reads bypass caches. */
  findByRequestKey(
    ownerId: string,
    requestKey: string,
  ): Promise<FundingRequest | null>;
  /** Claim initialization once, before any external call; only the winning caller may create checkout. */
  claimInitialization(id: string): Promise<boolean>;
  /** Save the authenticated partner's hosted checkout URL; this is not evidence of successful funding. */
  saveCheckout(id: string, checkoutUrl: string): Promise<void>;
  /** Permanently bind one partner movement to one intent, across webhook deliveries and reconciliation attempts. */
  recordVerifiedPayment(
    request: FundingRequest,
    externalMovementId: string,
  ): Promise<void>;
}
