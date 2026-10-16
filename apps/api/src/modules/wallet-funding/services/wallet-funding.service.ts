import { Inject, Injectable } from '@nestjs/common';
import { WalletService } from '@axiapay/backend/modules/wallets/services/wallet.service';
import { WalletError } from '@axiapay/backend/modules/wallets/domain/wallet-error';
import { FundingService } from './funding.service.js';
import {
  FundingError,
  fundingEvidence,
  type FundingOption,
  type FundingRequest,
} from '../domain/funding.js';
import type { AuthenticatedFundingNotification } from '../ports/funding-adapter.js';

/** Coordinate funding and wallet features; ledger posting remains atomic and replayable independently of partner requests. */
@Injectable()
export class WalletFundingService {
  /** Inject the verifier-backed wallet service and funding workflows; neither controllers nor provider clients post ledger entries. */
  constructor(
    @Inject(FundingService) private readonly funding: FundingService,
    @Inject(WalletService) private readonly wallets: WalletService,
  ) {}

  /** Authorize the destination before creating a partner order; frozen wallets may receive funds, closed wallets may not. */
  async initialize(
    input: Parameters<FundingService['initialize']>[0],
  ): Promise<FundingRequest> {
    const wallet = await this.wallets.getWalletBalance({
      actorId: input.actorId,
      walletId: input.walletId,
    });
    if (wallet.walletStatus === 'closed') {
      throw new WalletError('WALLET_RESTRICTED');
    }
    if (wallet.currency !== input.value.currency) {
      throw new WalletError('CURRENCY_MISMATCH');
    }
    return this.funding.initialize(input);
  }

  /** Authorize discovery against the wallet, then expose only currency-compatible options; no configured adapter means an empty list. */
  async listOptions(
    actorId: string,
    walletId: string,
  ): Promise<readonly FundingOption[]> {
    const wallet = await this.wallets.getWalletBalance({ actorId, walletId });
    if (wallet.walletStatus === 'closed') {
      throw new WalletError('WALLET_RESTRICTED');
    }
    return this.funding.listOptions(wallet.currency);
  }

  /** Expose an authoritative funding snapshot only to its owner. */
  getOwned(actorId: string, requestId: string): Promise<FundingRequest> {
    return this.funding.getOwned(actorId, requestId);
  }

  /** Recover a missed webhook or uncertain posting using the same request and partner movement identity. */
  async reconcile(actorId: string, requestId: string): Promise<FundingRequest> {
    const request = await this.funding.getOwned(actorId, requestId);
    if (request.operationId) {
      return request;
    }
    await this.wallets.confirmWalletFunding(fundingEvidence(request.id));
    return this.funding.getOwned(actorId, requestId);
  }

  /** Acknowledge only after verified credit or a committed identical replay; transient failures remain retryable by the partner. */
  async receiveNotification(
    notification: AuthenticatedFundingNotification,
  ): Promise<void> {
    const request = await this.funding.findNotificationRequest(notification);
    if (!request) {
      return;
    }
    if (
      request.operationId &&
      request.externalMovementId !== notification.externalMovementId
    ) {
      throw new FundingError('FUNDING_CONFLICT');
    }
    if (request.operationId) {
      return;
    }
    await this.wallets.confirmWalletFunding(
      fundingEvidence(request.id, notification.externalMovementId),
    );
  }
}
