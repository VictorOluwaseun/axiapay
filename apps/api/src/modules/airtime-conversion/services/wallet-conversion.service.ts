import { Inject, Injectable } from '@nestjs/common';
import { WalletService } from '@axiapay/backend/modules/wallets/services/wallet.service';
import { WalletError } from '@axiapay/backend/modules/wallets/domain/wallet-error';
import {
  ConversionError,
  type ConversionOffer,
  type ConversionQuote,
  type ConversionRequest,
} from '../domain/conversion.js';
import { ConversionService } from './conversion.service.js';

/** Coordinate owned destination wallets and conversion proof; the wallet feature alone authorizes and posts atomic money movements. */
@Injectable()
export class WalletConversionService {
  /** Use the same trusted proof verifier as the injected wallet module, without concrete repository/provider dependencies. */
  constructor(
    @Inject(ConversionService) private readonly conversions: ConversionService,
    @Inject(WalletService) private readonly wallets: WalletService,
  ) {}

  /** Authorize discovery for an eligible destination; frozen wallets may receive, closed wallets may not. */
  async listOffers(
    actorId: string,
    walletId: string,
  ): Promise<readonly ConversionOffer[]> {
    const wallet = await this.requireDestination(actorId, walletId);
    return this.conversions.listOffers(wallet.currency);
  }

  /** Validate the destination before checking eligibility; customers cannot choose a foreign account or wallet currency. */
  async quote(
    input: Omit<Parameters<ConversionService['quote']>[0], 'currency'>,
  ): Promise<ConversionQuote> {
    const wallet = await this.requireDestination(input.actorId, input.walletId);
    return this.conversions.quote({ ...input, currency: wallet.currency });
  }

  /** Read an owned immutable quote, including expired quotes needed to explain accepted work. */
  getQuote(actorId: string, quoteId: string): Promise<ConversionQuote> {
    return this.conversions.getQuote(actorId, quoteId);
  }

  /** Accept reviewed terms for the bound destination; normal replay remains available even after the wallet closes. */
  async accept(
    actorId: string,
    quoteId: string,
    requestKey: string,
  ): Promise<ConversionRequest> {
    const quote = await this.conversions.getQuote(actorId, quoteId);
    const existing = await this.conversions
      .findOwnedByKey(actorId, requestKey)
      .catch((error: unknown) => {
        if (
          error instanceof ConversionError &&
          error.code === 'CONVERSION_NOT_FOUND'
        ) {
          return null;
        }
        throw error;
      });
    if (!existing) {
      await this.requireDestination(actorId, quote.walletId);
    }
    const request = await this.conversions.accept(actorId, quoteId, requestKey);
    return this.creditVerified(request);
  }

  /** Get owned progress without causing external lookup or credit as a side effect of a read. */
  getOwned(actorId: string, conversionId: string): Promise<ConversionRequest> {
    return this.conversions.getOwned(actorId, conversionId);
  }

  /** Resolve response loss under an owner-scoped logical key. */
  findOwnedByKey(
    actorId: string,
    requestKey: string,
  ): Promise<ConversionRequest> {
    return this.conversions.findOwnedByKey(actorId, requestKey);
  }

  /** Lookup first, then recover credit from saved proof. A closed wallet or unavailable ledger retains the verified obligation. */
  async reconcile(
    actorId: string,
    conversionId: string,
  ): Promise<ConversionRequest> {
    return this.creditVerified(
      await this.conversions.reconcile(actorId, conversionId),
    );
  }

  /** Only verified exact net proceeds reach the ledger; movement identity is shared with other funding mechanisms. */
  private async creditVerified(
    request: ConversionRequest,
  ): Promise<ConversionRequest> {
    if (request.hasPostingConflict) {
      throw new ConversionError('CONVERSION_CONFLICT');
    }
    if (request.outcome?.outcome !== 'verified' || request.operationId) {
      return request;
    }
    await this.wallets.confirmWalletFunding(`airtime-conversion:${request.id}`);
    const credited = await this.conversions.getOwned(
      request.quote.ownerId,
      request.id,
    );
    if (!credited.operationId) {
      throw new ConversionError('CONVERSION_CONFLICT');
    }
    return credited;
  }

  /** Owner authorization precedes external work. Ledger posting independently rechecks currency and closure under its wallet lock. */
  private async requireDestination(actorId: string, walletId: string) {
    const wallet = await this.wallets.getWalletBalance({ actorId, walletId });
    if (wallet.walletStatus === 'closed') {
      throw new WalletError('WALLET_RESTRICTED');
    }
    return wallet;
  }
}
