import type {
  ConversionOutcome,
  ConversionQuote,
  ConversionRequest,
  TransferInstructions,
} from '../../domain/conversion.js';

/** Authoritative append-only conversion persistence; no cache is eligible for pricing, acceptance, evidence or credit state. */
export interface ConversionRepository {
  /** Persist an immutable quote and its eligibility evidence, independently of later route configuration. */
  saveQuote(quote: ConversionQuote): Promise<void>;
  /** Return the stored price/source snapshot; services enforce owner scope. */
  getQuote(id: string): Promise<ConversionQuote | null>;
  /** Serialize the owner/key and quote identities in one transaction. Identical replay bypasses new-acceptance policy; each quote can be accepted once. */
  acceptQuote(
    input: {
      readonly id: string;
      readonly ownerId: string;
      readonly quoteId: string;
      readonly requestKey: string;
    },
    authorize: (quote: ConversionQuote) =>
      | {
          readonly acceptedAt: Date;
          readonly receiveBy: Date;
        }
      | Promise<{ readonly acceptedAt: Date; readonly receiveBy: Date }>,
  ): Promise<ConversionRequest>;
  /** Read progress and derive operationId only from a committed matching ledger journal. */
  get(id: string): Promise<ConversionRequest | null>;
  /** Recover acceptance whose HTTP response was lost without manufacturing a new logical identity. */
  findByRequestKey(
    ownerId: string,
    requestKey: string,
  ): Promise<ConversionRequest | null>;
  /** Commit a one-time preparation claim before network I/O; no lease expiry permits resubmission. */
  claimPreparation(id: string): Promise<boolean>;
  /** Insert instructions once; identical replay is allowed, changed destinations or references conflict. */
  saveInstructions(
    id: string,
    instructions: TransferInstructions,
  ): Promise<void>;
  /** Persist terminal evidence before credit. A reused movement returns movement_conflict without inserting; changed final proof throws. */
  saveOutcome(
    id: string,
    partnerAccountId: string,
    outcome: ConversionOutcome,
  ): Promise<'saved' | 'movement_conflict'>;
}
