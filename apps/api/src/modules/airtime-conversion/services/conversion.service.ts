import { RemoteConfigService } from '../../remote-config/services/remote-config.service.js';
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { money } from '@axiapay/payments-runtime/modules/wallets/domain/money';
import type {
  ConfirmedFunding,
  FundingVerification,
} from '@axiapay/payments-runtime/modules/wallets/ports/wallet-verification';
import { CONVERSION } from '../conversion.tokens.js';
import {
  ConversionError,
  assertConversionId,
  assertConversionOffer,
  assertConversionReference,
  assertSourcePhone,
  calculateConversionAmounts,
  conversionFingerprint,
  offerFingerprint,
  type ConversionExceptionCode,
  type ConversionOffer,
  type ConversionOutcome,
  type ConversionQuote,
  type ConversionRequest,
  type TransferInstructions,
} from '../domain/conversion.js';
import type {
  ConversionInspection,
  ConversionRoute,
  ConversionTransferInput,
  VerifiedAirtimeReceipt,
} from '../ports/airtime-conversion-provider.js';
import type { ConversionRepository } from '../repositories/contracts/conversion.repository.js';

/** Own eligibility, frozen pricing, acceptance and receipt verification. External capability calls never run inside storage transactions. */
@Injectable()
export class ConversionService implements FundingVerification {
  private readonly routes: readonly ConversionRoute[];

  /** Snapshot explicit route configuration; an empty registry cannot quote or accept new conversions. */
  constructor(
    @Inject(RemoteConfigService)
    private readonly configuration: RemoteConfigService,
    @Inject(CONVERSION.repository)
    private readonly conversions: ConversionRepository,
    @Inject(CONVERSION.routes) routes: readonly ConversionRoute[],
  ) {
    const providers = new Set<string>();
    const offers = new Set<string>();
    for (const route of routes) {
      assertConversionReference(route.providerId);
      assertConversionId(route.partnerAccountId);
      if (providers.has(route.providerId)) {
        throw new ConversionError('INVALID_CONVERSION');
      }
      providers.add(route.providerId);
      for (const offer of route.offers) {
        assertConversionOffer(offer);
        assertConversionReference(offer.providerProductCode);
        if (offers.has(offer.id)) {
          throw new ConversionError('INVALID_CONVERSION');
        }
        offers.add(offer.id);
      }
    }
    this.routes = Object.freeze(
      routes.map((route) =>
        Object.freeze({
          ...route,
          offers: Object.freeze(
            route.offers.map((offer) => Object.freeze({ ...offer })),
          ),
        }),
      ),
    );
  }

  /** Discover only explicitly enabled, currency-compatible offers; no provider identities or proposed commercial defaults are returned. */
  async listOffers(currency: string): Promise<readonly ConversionOffer[]> {
    if (!(await this.configuration.isEnabled('airtime_conversion'))) {
      return [];
    }
    return this.routes
      .filter((route) => route.acceptsNewRequests)
      .flatMap((route) =>
        route.offers.filter((offer) => offer.currency === currency),
      );
  }

  /** Check current source eligibility and disclose all pricing before acceptance. Source ownership/security is an adapter obligation. */
  async quote(input: {
    readonly actorId: string;
    readonly walletId: string;
    readonly offerId: string;
    readonly sourcePhoneNumber: string;
    readonly airtimeMinorUnits: bigint;
    readonly currency: string;
  }): Promise<ConversionQuote> {
    if (!(await this.configuration.isEnabled('airtime_conversion'))) {
      throw new ConversionError('FEATURE_DISABLED');
    }
    const route = this.routes.find(
      (candidate) =>
        candidate.acceptsNewRequests &&
        candidate.offers.some(
          (offer) =>
            offer.id === input.offerId && offer.currency === input.currency,
        ),
    );
    const offer = route?.offers.find(
      (candidate) => candidate.id === input.offerId,
    );
    if (!route || !offer) {
      throw new ConversionError('AIRTIME_INELIGIBLE');
    }
    const amounts = calculateConversionAmounts(offer, input.airtimeMinorUnits);
    const quotedAt = new Date();
    const eligibility = await route.provider.checkEligibility({
      providerProductCode: offer.providerProductCode,
      sourcePhoneNumber: input.sourcePhoneNumber,
      networkCode: offer.networkCode,
      airtimeValue: amounts.airtimeValue,
    });
    if (!eligibility.isEligible) {
      throw new ConversionError('AIRTIME_INELIGIBLE');
    }
    assertConversionReference(eligibility.eligibilityReference);
    if (
      !isValidDate(eligibility.expiresAt) ||
      eligibility.expiresAt.getTime() <= Date.now()
    ) {
      throw new ConversionError('AIRTIME_INELIGIBLE');
    }
    const expiresAt = new Date(
      Math.min(
        quotedAt.getTime() + offer.quoteValiditySeconds * 1000,
        eligibility.expiresAt.getTime(),
      ),
    );
    if (expiresAt.getTime() <= Date.now()) {
      throw new ConversionError('QUOTE_EXPIRED');
    }
    const quote: ConversionQuote = {
      id: randomUUID(),
      ownerId: input.actorId,
      walletId: input.walletId,
      sourcePhoneNumber: input.sourcePhoneNumber,
      offer,
      providerId: route.providerId,
      partnerAccountId: route.partnerAccountId,
      providerProductCode: offer.providerProductCode,
      eligibilityReference: eligibility.eligibilityReference,
      quotedAt,
      expiresAt,
      ...amounts,
    };
    await this.conversions.saveQuote(quote);
    return quote;
  }

  /** Inaccessible and missing quotes have the same error; customer input never selects a different wallet on acceptance. */
  async getQuote(actorId: string, quoteId: string): Promise<ConversionQuote> {
    const quote = await this.conversions.getQuote(quoteId);
    if (!quote || quote.ownerId !== actorId) {
      throw new ConversionError('CONVERSION_NOT_FOUND');
    }
    return quote;
  }

  /** Persist consent before issuing instructions. Owner/key and quote deduplication survive concurrent acceptance and lost responses. */
  async accept(
    actorId: string,
    quoteId: string,
    requestKey: string,
  ): Promise<ConversionRequest> {
    const request = await this.conversions.acceptQuote(
      { id: randomUUID(), ownerId: actorId, quoteId, requestKey },
      (quote) => this.authorizeAcceptance(quote),
    );
    return this.prepare(request);
  }

  /** Replays honor original accepted terms; this policy runs only for new acceptance under the repository's quote lock. */
  private async authorizeAcceptance(quote: ConversionQuote): Promise<{
    acceptedAt: Date;
    receiveBy: Date;
  }> {
    if (!(await this.configuration.isEnabled('airtime_conversion'))) {
      throw new ConversionError('FEATURE_DISABLED');
    }
    const acceptedAt = new Date();
    if (acceptedAt >= quote.expiresAt) {
      throw new ConversionError('QUOTE_EXPIRED');
    }
    const route = this.findBoundRoute(quote);
    if (!route) {
      throw new ConversionError('CONVERSION_TERMS_CHANGED');
    }
    const offer = route.offers.find(
      (candidate) => candidate.id === quote.offer.id,
    );
    if (
      !route.acceptsNewRequests ||
      !offer ||
      offerFingerprint(offer) !== offerFingerprint(quote.offer) ||
      offer.providerProductCode !== quote.providerProductCode
    ) {
      throw new ConversionError('CONVERSION_TERMS_CHANGED');
    }
    return {
      acceptedAt,
      receiveBy: new Date(
        acceptedAt.getTime() + quote.offer.transferWindowSeconds * 1000,
      ),
    };
  }

  /** Restrict progress to its owner, including retries after quote expiry or adapter withdrawal. */
  async getOwned(
    actorId: string,
    conversionId: string,
  ): Promise<ConversionRequest> {
    const request = await this.require(conversionId);
    if (request.quote.ownerId !== actorId) {
      throw new ConversionError('CONVERSION_NOT_FOUND');
    }
    return request;
  }

  /** Recover an accepted logical request without exposing a different owner's keys or records. */
  async findOwnedByKey(
    actorId: string,
    requestKey: string,
  ): Promise<ConversionRequest> {
    const request = await this.conversions.findByRequestKey(
      actorId,
      requestKey,
    );
    if (!request) {
      throw new ConversionError('CONVERSION_NOT_FOUND');
    }
    return request;
  }

  /** Inspect the same accepted identity without initiating airtime movement. Terminal evidence is retained and never queried away. */
  async reconcile(
    actorId: string,
    conversionId: string,
  ): Promise<ConversionRequest> {
    const request = await this.getOwned(actorId, conversionId);
    if (request.outcome || request.operationId || request.hasPostingConflict) {
      return request;
    }
    if (!request.initializationStartedAt) {
      return this.prepare(request);
    }
    const inspection = await this.boundRoute(
      request.quote,
    ).provider.inspectTransfer(transferInput(request));
    return this.recordInspection(request, inspection);
  }

  /** Ledger capability consumes saved authenticated proof; adapter removal or lookup outage cannot erase a verified credit obligation. */
  async verifyFunding(evidenceReference: string): Promise<ConfirmedFunding> {
    const match = /^airtime-conversion:([0-9a-f-]{36})$/.exec(
      evidenceReference,
    );
    if (!match) {
      throw new ConversionError('INVALID_CONVERSION');
    }
    assertConversionId(match[1]!);
    const request = await this.require(match[1]!);
    if (request.hasPostingConflict) {
      throw new ConversionError('CONVERSION_CONFLICT');
    }
    if (
      request.outcome?.outcome !== 'verified' ||
      !request.outcome.externalMovementId
    ) {
      throw new ConversionError('CONVERSION_UNAVAILABLE');
    }
    return {
      walletId: request.quote.walletId,
      partnerAccountId: request.quote.partnerAccountId,
      externalMovementId: request.outcome.externalMovementId,
      evidenceReference,
      value: request.quote.netCreditValue,
    };
  }

  /** Claim once before I/O. An expired window, prior claim or terminal proof never authorizes a fresh external preparation. */
  private async prepare(
    request: ConversionRequest,
  ): Promise<ConversionRequest> {
    if (
      request.initializationStartedAt ||
      request.outcome ||
      request.receiveBy.getTime() < Date.now()
    ) {
      return request;
    }
    const route = this.boundRoute(request.quote);
    if (!(await this.conversions.claimPreparation(request.id))) {
      return this.require(request.id);
    }
    const inspection = await route.provider.prepareTransfer(
      transferInput(request),
    );
    return this.recordInspection(request, inspection);
  }

  /** Retain canonical instructions before examining receipt. Invalid correlation produces a visible exception, never credit. */
  private async recordInspection(
    request: ConversionRequest,
    inspection: ConversionInspection,
  ): Promise<ConversionRequest> {
    if (
      inspection.conversionId !== request.id ||
      inspection.requestFingerprint !== conversionFingerprint(request)
    ) {
      return this.recordVerificationFailure(
        request,
        `correlation-rejected:${request.id}`,
      );
    }
    if (
      inspection.instructions &&
      !hasValidInstructions(request, inspection.instructions)
    ) {
      return this.recordVerificationFailure(
        request,
        `instructions-rejected:${request.id}`,
      );
    }
    if (inspection.instructions) {
      await this.conversions.saveInstructions(
        request.id,
        inspection.instructions,
      );
    }
    const current = await this.require(request.id);
    if (inspection.receiptStatus === 'pending') {
      return current;
    }
    if (inspection.receiptStatus === 'verification_failed') {
      return this.recordVerificationFailure(
        current,
        inspection.evidenceReference,
      );
    }
    if (
      !current.instructions ||
      !hasValidReceiptIdentity(current, inspection.receipt)
    ) {
      return this.recordVerificationFailure(
        current,
        `receipt-rejected:${request.id}`,
      );
    }
    const receipt = inspection.receipt;
    const exceptionCode = receiptException(current, receipt);
    const outcome: ConversionOutcome = {
      outcome: exceptionCode ? 'exception' : 'verified',
      exceptionCode,
      externalMovementId: receipt.externalMovementId,
      evidenceReference: receipt.evidenceReference,
      receivedAt: receipt.receivedAt,
      observedAirtimeValue: receipt.airtimeValue,
      receiptFingerprint: receiptFingerprint(receipt),
    };
    const saved = await this.conversions.saveOutcome(
      request.id,
      request.quote.partnerAccountId,
      outcome,
    );
    if (saved === 'movement_conflict') {
      // Retain conflicting proof for support without claiming the economic movement again.
      await this.conversions.saveOutcome(
        request.id,
        request.quote.partnerAccountId,
        {
          ...outcome,
          outcome: 'exception',
          exceptionCode: 'movement_conflict',
          externalMovementId: null,
        },
      );
    }
    return this.require(request.id);
  }

  /** Record bounded verification failure independently of user assertions or unauthenticated economic identities. */
  private async recordVerificationFailure(
    request: ConversionRequest,
    evidenceReference: string,
  ): Promise<ConversionRequest> {
    assertConversionReference(evidenceReference);
    await this.conversions.saveOutcome(
      request.id,
      request.quote.partnerAccountId,
      {
        outcome: 'exception',
        exceptionCode: 'verification_failed',
        externalMovementId: null,
        evidenceReference,
        receivedAt: null,
        observedAirtimeValue: null,
        receiptFingerprint: JSON.stringify({
          conversionId: request.id,
          evidenceReference,
          receiptStatus: 'verification_failed',
        }),
      },
    );
    return this.require(request.id);
  }

  /** Match the original realm and account; replacements are never used to inspect already accepted work. */
  private boundRoute(quote: ConversionQuote): ConversionRoute {
    const route = this.findBoundRoute(quote);
    if (!route) {
      throw new ConversionError('CONVERSION_UNAVAILABLE');
    }
    return route;
  }

  /** Resolve one immutable realm/account pair; callers distinguish new-consent ineligibility from recovery unavailability. */
  private findBoundRoute(quote: ConversionQuote): ConversionRoute | undefined {
    return this.routes.find(
      (candidate) =>
        candidate.providerId === quote.providerId &&
        candidate.partnerAccountId === quote.partnerAccountId,
    );
  }

  /** Read authoritative progress after committing proof, without disguising missing persistence as pending. */
  private async require(id: string): Promise<ConversionRequest> {
    const request = await this.conversions.get(id);
    if (!request) {
      throw new ConversionError('CONVERSION_NOT_FOUND');
    }
    return request;
  }
}

/** Copy accepted capability terms for preparation and inspections; preserve isolation without reconstructing already validated Money. */
function transferInput(request: ConversionRequest): ConversionTransferInput {
  return {
    conversionId: request.id,
    requestFingerprint: conversionFingerprint(request),
    providerProductCode: request.quote.providerProductCode,
    sourcePhoneNumber: request.quote.sourcePhoneNumber,
    networkCode: request.quote.offer.networkCode,
    airtimeValue: Object.freeze({ ...request.quote.airtimeValue }),
    netCreditValue: Object.freeze({ ...request.quote.netCreditValue }),
    eligibilityReference: request.quote.eligibilityReference,
    acceptedAt: new Date(request.acceptedAt.getTime()),
    receiveBy: new Date(request.receiveBy.getTime()),
  };
}

/** Reject invalid dates without implicitly parsing untrusted strings at the domain boundary. */
function isValidDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/** Fixed instructions must fit the accepted window; late lookup can recover historically timely instructions. */
function hasValidInstructions(
  request: ConversionRequest,
  instructions: TransferInstructions,
): boolean {
  try {
    assertConversionReference(instructions.instructionReference);
    assertSourcePhone(instructions.receivingPhoneNumber);
  } catch {
    return false;
  }
  return (
    typeof instructions.description === 'string' &&
    instructions.description.trim().length > 0 &&
    instructions.description.length <= 1000 &&
    !/\p{Cc}/u.test(instructions.description) &&
    isValidDate(instructions.issuedAt) &&
    instructions.issuedAt >= request.acceptedAt &&
    instructions.issuedAt <= request.receiveBy &&
    instructions.issuedAt.getTime() <= Date.now()
  );
}

/** Correlation and structurally valid economic evidence precede any movement claim; mismatching commercial values are retained as exceptions. */
function hasValidReceiptIdentity(
  request: ConversionRequest,
  receipt: VerifiedAirtimeReceipt,
): boolean {
  if (
    receipt.conversionId !== request.id ||
    receipt.requestFingerprint !== conversionFingerprint(request) ||
    !isValidDate(receipt.receivedAt)
  ) {
    return false;
  }
  try {
    assertConversionReference(receipt.externalMovementId);
    assertConversionReference(receipt.evidenceReference);
    assertConversionReference(receipt.instructionReference);
    assertSourcePhone(receipt.sourcePhoneNumber);
    assertSourcePhone(receipt.receivingPhoneNumber);
    money(receipt.airtimeValue.amountMinorUnits, receipt.airtimeValue.currency);
    money(
      receipt.netCreditValue.amountMinorUnits,
      receipt.netCreditValue.currency,
    );
  } catch {
    return false;
  }
  return /^[a-z][a-z0-9-]{0,63}$/.test(receipt.networkCode);
}

/** Actual receipt time governs timeliness, so a delayed poll can still settle a timely transfer. No repricing or partial credit. */
function receiptException(
  request: ConversionRequest,
  receipt: VerifiedAirtimeReceipt,
): ConversionExceptionCode | null {
  if (
    receipt.airtimeValue.amountMinorUnits !==
      request.quote.airtimeValue.amountMinorUnits ||
    receipt.airtimeValue.currency !== request.quote.airtimeValue.currency
  ) {
    return 'amount_mismatch';
  }
  if (receipt.receivedAt > request.receiveBy) {
    return 'late_receipt';
  }
  if (
    receipt.receivedAt.getTime() > Date.now() ||
    receipt.receivedAt < request.instructions!.issuedAt ||
    receipt.sourcePhoneNumber !== request.quote.sourcePhoneNumber ||
    receipt.networkCode !== request.quote.offer.networkCode ||
    receipt.receivingPhoneNumber !==
      request.instructions!.receivingPhoneNumber ||
    receipt.instructionReference !==
      request.instructions!.instructionReference ||
    receipt.netCreditValue.currency !== request.quote.netCreditValue.currency ||
    receipt.netCreditValue.amountMinorUnits !==
      request.quote.netCreditValue.amountMinorUnits
  ) {
    return 'terms_mismatch';
  }
  return null;
}

/** Canonical, bounded receipt snapshot excludes arbitrary SDK fields and serializes exact amounts without number conversion. */
function receiptFingerprint(receipt: VerifiedAirtimeReceipt): string {
  return JSON.stringify({
    conversionId: receipt.conversionId,
    requestFingerprint: receipt.requestFingerprint,
    externalMovementId: receipt.externalMovementId,
    evidenceReference: receipt.evidenceReference,
    sourcePhoneNumber: receipt.sourcePhoneNumber,
    networkCode: receipt.networkCode,
    receivingPhoneNumber: receipt.receivingPhoneNumber,
    instructionReference: receipt.instructionReference,
    airtimeValue: {
      amountMinorUnits: receipt.airtimeValue.amountMinorUnits.toString(),
      currency: receipt.airtimeValue.currency,
    },
    netCreditValue: {
      amountMinorUnits: receipt.netCreditValue.amountMinorUnits.toString(),
      currency: receipt.netCreditValue.currency,
    },
    receivedAt: receipt.receivedAt.toISOString(),
  });
}
