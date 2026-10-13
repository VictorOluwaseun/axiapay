import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { FUNDING } from '../funding.tokens.js';
import type { FundingRepository } from '../repositories/contracts/funding.repository.js';
import type {
  FundingAdapter,
  FundingRoute,
  AuthenticatedFundingNotification,
} from '../ports/funding-adapter.js';
import {
  assertFundingPayment,
  FundingError,
  type FundingOption,
  type FundingRequest,
} from '../domain/funding.js';
import {
  assertReference,
  money,
  type Money,
} from '../../wallets/domain/money.js';
import type {
  ConfirmedFunding,
  FundingVerification,
} from '../../wallets/ports/wallet-verification.js';
import { normalizeContact } from '../../authentication/domain/authentication-policy.js';
import { validateFundingRoutes } from './funding-routing.js';

/** AxiaPay funding intent, routing, and independent verification. Provider protocols and HTTP evidence stay outside this service. */
@Injectable()
export class FundingService implements FundingVerification {
  private readonly routes: readonly FundingRoute[];

  /** Inject authoritative persistence and explicit capability bindings; an empty list disables external funding safely. */
  constructor(
    @Inject(FUNDING.repository) private readonly repository: FundingRepository,
    @Inject(FUNDING.routes) routes: readonly FundingRoute[],
  ) {
    validateFundingRoutes(routes);
    this.routes = routes.map((route) =>
      Object.freeze({ ...route, option: Object.freeze({ ...route.option }) }),
    );
  }

  /** List only enabled options for this currency; customer authorization belongs to the coordinating wallet workflow. */
  listOptions(currency: string): readonly FundingOption[] {
    return this.routes
      .filter(
        (route) =>
          route.acceptsNewRequests && route.option.currency === currency,
      )
      .map((route) => ({ ...route.option }));
  }

  /** After wallet authorization by WalletFundingService, persist the chosen binding before checkout; retries retain the original route. */
  async initialize(input: {
    actorId: string;
    walletId: string;
    fundingOptionId: string;
    value: Money;
    payerEmail: string;
    requestKey: string;
  }): Promise<FundingRequest> {
    const value = money(input.value.amountMinorUnits, input.value.currency);
    assertReference(input.actorId);
    assertReference(input.requestKey);
    const payerEmail = normalizeContact({
      kind: 'email',
      value: input.payerEmail,
    }).value;
    const existing = await this.repository.findByRequestKey(
      input.actorId,
      input.requestKey,
    );
    if (existing) {
      this.assertReplay(existing, { ...input, value, payerEmail });
      return this.initializeRequest(existing);
    }
    const route = this.routes.find(
      (candidate) =>
        candidate.acceptsNewRequests &&
        candidate.option.id === input.fundingOptionId,
    );
    if (!route) {
      throw new FundingError('FUNDING_UNAVAILABLE');
    }
    if (
      route.option.currency !== value.currency ||
      value.amountMinorUnits < route.option.minimumAmountMinorUnits ||
      value.amountMinorUnits > route.option.maximumAmountMinorUnits
    ) {
      throw new FundingError('INVALID_FUNDING');
    }
    const request = await this.repository.create({
      id: randomUUID(),
      ownerId: input.actorId,
      walletId: input.walletId,
      fundingOptionId: input.fundingOptionId,
      adapterId: route.adapterId,
      environment: route.adapter.environment,
      partnerAccountId: route.adapter.partnerAccountId,
      value,
      payerEmail,
      requestKey: input.requestKey,
      requestFingerprint: JSON.stringify([
        input.walletId,
        input.fundingOptionId,
        value.currency,
        value.amountMinorUnits.toString(),
        payerEmail,
      ]),
    });
    return this.initializeRequest(request);
  }

  /** Authorize reads/reconciliation by the saved owner, never provider metadata or receipt email. */
  async getOwned(actorId: string, requestId: string): Promise<FundingRequest> {
    const request = await this.requireRequest(requestId);
    if (request.ownerId !== actorId) {
      throw new FundingError('FUNDING_NOT_FOUND');
    }
    return request;
  }

  /** Ignore authentic events for other products; enforce the authenticating account, adapter, and environment for known references. */
  async findNotificationRequest(
    notification: AuthenticatedFundingNotification,
  ): Promise<FundingRequest | null> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/.test(
        notification.reference,
      )
    ) {
      return null;
    }
    const request = await this.repository.get(notification.reference);
    if (!request) {
      return null;
    }
    if (
      request.adapterId !== notification.adapterId ||
      request.environment !== notification.environment ||
      request.partnerAccountId !== notification.partnerAccountId
    ) {
      throw new FundingError('INVALID_WEBHOOK');
    }
    assertReference(notification.externalMovementId);
    return request;
  }

  /** Re-query the bound adapter and require exact identity, currency, amount, and success before recording an economic movement. */
  async verifyFunding(evidenceReference: string): Promise<ConfirmedFunding> {
    const [requestId, expectedMovementId] =
      this.parseEvidence(evidenceReference);
    const request = await this.requireRequest(requestId);
    const payment = await this.requestAdapter(request).verify(request.id);
    assertFundingPayment(request, payment);
    if (
      expectedMovementId !== null &&
      expectedMovementId !== payment.externalMovementId
    ) {
      throw new FundingError('INVALID_FUNDING');
    }
    assertReference(payment.externalMovementId);
    await this.repository.recordVerifiedPayment(
      request,
      payment.externalMovementId,
    );
    return {
      walletId: request.walletId,
      partnerAccountId: request.partnerAccountId,
      externalMovementId: payment.externalMovementId,
      evidenceReference: `funding:${request.id}`,
      value: request.value,
    };
  }

  /** Claim external submission once. A lost response leaves durable pending intent; retries never create another external order. */
  private async initializeRequest(
    request: FundingRequest,
  ): Promise<FundingRequest> {
    if (request.checkoutUrl || request.initializationStartedAt) {
      return request;
    }
    const adapter = this.requestAdapter(request);
    const claimed = await this.repository.claimInitialization(request.id);
    if (!claimed) {
      return this.requireRequest(request.id);
    }
    const checkoutUrl = await adapter.initialize({
      reference: request.id,
      value: request.value,
      payerEmail: request.payerEmail,
    });
    this.assertCheckoutUrl(checkoutUrl);
    await this.repository.saveCheckout(request.id, checkoutUrl);
    return this.requireRequest(request.id);
  }

  /** Compare customer intent independently of current routing, allowing old requests to survive adapter configuration changes. */
  private assertReplay(
    request: FundingRequest,
    input: {
      walletId: string;
      fundingOptionId: string;
      value: Money;
      payerEmail: string;
    },
  ): void {
    if (
      request.walletId !== input.walletId ||
      request.fundingOptionId !== input.fundingOptionId ||
      request.value.currency !== input.value.currency ||
      request.value.amountMinorUnits !== input.value.amountMinorUnits ||
      request.payerEmail !== input.payerEmail
    ) {
      throw new FundingError('FUNDING_CONFLICT');
    }
  }

  /** Resolve persisted intent only; notifications and customer input cannot create missing financial records. */
  private async requireRequest(id: string): Promise<FundingRequest> {
    const request = await this.repository.get(id);
    if (!request) {
      throw new FundingError('FUNDING_NOT_FOUND');
    }
    return request;
  }

  /** Never fail over an accepted request to another account or environment; only its original binding may verify it. */
  private requestAdapter(request: FundingRequest): FundingAdapter {
    const route = this.routes.find(
      (candidate) =>
        candidate.adapterId === request.adapterId &&
        candidate.adapter.environment === request.environment &&
        candidate.adapter.partnerAccountId === request.partnerAccountId,
    );
    if (!route) {
      throw new FundingError('FUNDING_UNAVAILABLE');
    }
    return route.adapter;
  }

  /** Parse internal evidence without assuming any provider-specific external ID format. */
  private parseEvidence(evidence: string): [string, string | null] {
    let fields: unknown;
    try {
      fields = JSON.parse(evidence);
    } catch (cause) {
      throw new FundingError('INVALID_FUNDING', { cause });
    }
    if (
      !Array.isArray(fields) ||
      fields.length !== 2 ||
      typeof fields[0] !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/.test(
        fields[0],
      ) ||
      (fields[1] !== null && typeof fields[1] !== 'string')
    ) {
      throw new FundingError('INVALID_FUNDING');
    }
    return [fields[0], fields[1] as string | null];
  }

  /** Enforce the public redirect contract defensively; adapters additionally validate their own provider-specific host allowlists. */
  private assertCheckoutUrl(value: string): void {
    let url: URL;
    try {
      url = new URL(value);
    } catch (cause) {
      throw new FundingError('INVALID_FUNDING', { cause });
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      value.length > 4096
    ) {
      throw new FundingError('INVALID_FUNDING');
    }
  }
}
