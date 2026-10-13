import { Inject, Injectable } from '@nestjs/common';
import { WALLET } from '../wallet.tokens.js';
import {
  assertCurrency,
  assertReference,
  money,
  type Money,
} from '../domain/money.js';
import {
  assertCanSpend,
  assertWalletActive,
  assertWalletOwner,
  type Wallet,
} from '../domain/wallet.js';
import { WalletError } from '../domain/wallet-error.js';
import type {
  WalletRepository,
  WalletReceipt,
} from '../repositories/contracts/wallet.repository.js';
import type { FundingVerification } from '../ports/wallet-verification.js';
import {
  WalletReservationService,
  type ReserveWalletFundsInput,
} from './wallet-reservation.service.js';
/** Inputs authorized by the authenticated adapter; requestKey identifies this transfer across every transport. */
export interface WalletTransferInput {
  readonly actorId: string;
  readonly sourceWalletId: string;
  readonly destinationWalletId: string;
  readonly requestKey: string;
  readonly value: Money;
}

/** Own wallet provisioning, balance access, transfers, and verified funding; delegate held-money transitions to the reservation service. */
@Injectable()
export class WalletService {
  /** Keep workflows behind repository and verification contracts; storage clients never enter this service. */
  constructor(
    @Inject(WALLET.repository) private readonly wallets: WalletRepository,
    @Inject(WALLET.funding) private readonly funding: FundingVerification,
    @Inject(WalletReservationService)
    private readonly reservations: WalletReservationService,
  ) {}
  /** Create both liability accounts atomically, or return the existing owner/currency wallet. */
  createWallet(input: {
    readonly actorId: string;
    readonly currency: string;
  }): Promise<Wallet> {
    assertReference(input.actorId);
    assertCurrency(input.currency);
    return this.wallets.createWallet(input.actorId, input.currency);
  }
  /** Return a consistent balance snapshot after checking ownership. */
  async getWalletBalance(input: {
    readonly actorId: string;
    readonly walletId: string;
  }): Promise<Wallet> {
    const wallet = await this.wallets.getWallet(input.walletId);
    assertWalletOwner(wallet, input.actorId);
    return wallet;
  }
  /** Enforce ownership, currency, funds and idempotency; no external provider is involved. */
  transferBetweenWallets(input: WalletTransferInput): Promise<WalletReceipt> {
    const value = money(input.value.amountMinorUnits, input.value.currency);
    assertReference(input.actorId);
    assertReference(input.requestKey);
    if (input.sourceWalletId === input.destinationWalletId) {
      throw new WalletError('INVALID_TRANSFER');
    }
    return this.wallets.executeOnce(
      {
        requestScope: `customer:${input.actorId}`,
        requestKey: input.requestKey,
        requestFingerprint: JSON.stringify([
          'transfer',
          input.sourceWalletId,
          input.destinationWalletId,
          value.currency,
          value.amountMinorUnits.toString(),
        ]),
      },
      async (transaction, operationId) => {
        const snapshots = await transaction.lockWallets([
          input.sourceWalletId,
          input.destinationWalletId,
        ]);
        const source = snapshots.find(
          (wallet) => wallet.id === input.sourceWalletId,
        );
        const destination = snapshots.find(
          (wallet) => wallet.id === input.destinationWalletId,
        );
        if (!source || !destination) {
          throw new WalletError('WALLET_NOT_FOUND');
        }
        assertWalletOwner(source, input.actorId);
        assertCanSpend(source, value);
        assertWalletActive(destination);
        if (destination.currency !== value.currency) {
          throw new WalletError('CURRENCY_MISMATCH');
        }
        return transaction.postJournal(operationId, {
          journalKind: 'transfer',
          currency: value.currency,
          entries: [
            {
              accountId: source.availableAccountId,
              side: 'debit',
              amountMinorUnits: value.amountMinorUnits,
            },
            {
              accountId: destination.availableAccountId,
              side: 'credit',
              amountMinorUnits: value.amountMinorUnits,
            },
          ],
        });
      },
    );
  }
  /** Verify before opening a transaction; frozen wallets may receive funds but remain unable to spend. */
  async confirmWalletFunding(
    evidenceReference: string,
  ): Promise<WalletReceipt> {
    assertReference(evidenceReference);
    const funding = await this.funding.verifyFunding(evidenceReference);
    const value = money(funding.value.amountMinorUnits, funding.value.currency);
    assertReference(funding.externalMovementId);
    assertReference(funding.evidenceReference);
    return this.wallets.executeOnce(
      {
        requestScope: `funding:${funding.partnerAccountId}`,
        requestKey: funding.externalMovementId,
        // Different notifications can describe the same movement; transport evidence is not identity.
        requestFingerprint: JSON.stringify([
          'funding',
          funding.walletId,
          value.currency,
          value.amountMinorUnits.toString(),
        ]),
      },
      async (transaction, operationId) => {
        const [wallet] = await transaction.lockWallets([funding.walletId]);
        if (!wallet) {
          throw new WalletError('WALLET_NOT_FOUND');
        }
        if (wallet.walletStatus === 'closed') {
          throw new WalletError('WALLET_RESTRICTED');
        }
        if (wallet.currency !== value.currency) {
          throw new WalletError('CURRENCY_MISMATCH');
        }
        const accountId = await transaction.getSystemAccount(
          funding.partnerAccountId,
          'partner_funds',
          value.currency,
        );
        return transaction.postJournal(operationId, {
          journalKind: 'funding',
          currency: value.currency,
          evidenceReference: funding.evidenceReference,
          entries: [
            {
              accountId,
              side: 'debit',
              amountMinorUnits: value.amountMinorUnits,
            },
            {
              accountId: wallet.availableAccountId,
              side: 'credit',
              amountMinorUnits: value.amountMinorUnits,
            },
          ],
        });
      },
    );
  }
  /** Reserve accepted payment terms with the same authorization and idempotency rules for all callers. */
  reserveWalletFunds(input: ReserveWalletFundsInput): Promise<WalletReceipt> {
    return this.reservations.reserve(input);
  }
  /** Resolve a hold only after trusted provider verification; replay returns the original receipt. */
  settleWalletReservation(
    input: Parameters<WalletReservationService['settle']>[0],
  ): Promise<WalletReceipt> {
    return this.reservations.settle(input);
  }
}
