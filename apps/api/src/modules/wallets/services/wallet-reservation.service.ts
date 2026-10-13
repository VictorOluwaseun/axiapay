import { Inject, Injectable, Optional } from '@nestjs/common';
import { WALLET } from '../wallet.tokens.js';
import { assertReference, money, type Money } from '../domain/money.js';
import type { LedgerEntry } from '../domain/journal.js';
import {
  assertCanSpend,
  assertWalletOwner,
  assertReservationOpen,
} from '../domain/wallet.js';
import { WalletError } from '../domain/wallet-error.js';
import type {
  WalletRepository,
  WalletReceipt,
  WalletTransaction,
} from '../repositories/contracts/wallet.repository.js';
import type {
  PaymentOutcomeVerification,
  VerifiedPaymentOutcome,
} from '../ports/wallet-verification.js';
/** The accepted payment's total debit, including fees, and a durable payment identity. */
export interface ReserveWalletFundsInput {
  readonly actorId: string;
  readonly walletId: string;
  readonly requestKey: string;
  readonly paymentReference: string;
  readonly value: Money;
  /** Recheck optional application authorization while wallet locks are held; must be synchronous with no I/O or external side effects.
   * Runs only for a new hold. Committed idempotent replays retain the originally accepted authorization.
   */
  readonly validateAuthorization?: () => void;
}

/** Build the verified success credits; zero fees do not create zero-value ledger lines. */
async function settlementCredits(
  transaction: WalletTransaction,
  outcome: Extract<VerifiedPaymentOutcome, { outcome: 'succeeded' }>,
): Promise<LedgerEntry[]> {
  const principal = money(
    outcome.principal.amountMinorUnits,
    outcome.principal.currency,
  );
  if (typeof outcome.feeMinorUnits !== 'bigint' || outcome.feeMinorUnits < 0n) {
    throw new WalletError('INVALID_AMOUNT');
  }
  const accountId = await transaction.getSystemAccount(
    outcome.partnerAccountId,
    'partner_funds',
    principal.currency,
  );
  const credits: LedgerEntry[] = [
    { accountId, side: 'credit', amountMinorUnits: principal.amountMinorUnits },
  ];
  if (outcome.feeMinorUnits === 0n) {
    return credits;
  }
  money(outcome.feeMinorUnits, principal.currency);
  if (!outcome.feeAccountId) {
    throw new WalletError('LEDGER_CONFIGURATION');
  }
  const feeAccountId = await transaction.getSystemAccount(
    outcome.feeAccountId,
    'fee_income',
    principal.currency,
  );
  credits.push({
    accountId: feeAccountId,
    side: 'credit',
    amountMinorUnits: outcome.feeMinorUnits,
  });
  return credits;
}

/** Own held-money transitions from reservation through verified capture or safe release; uncertain outcomes preserve the hold. */
@Injectable()
export class WalletReservationService {
  /** Inject persistence and optional outcome verification; absent verification disables settlement and preserves holds. */
  constructor(
    @Inject(WALLET.repository) private readonly wallets: WalletRepository,
    @Optional()
    @Inject(WALLET.paymentOutcome)
    private readonly verification: PaymentOutcomeVerification | undefined,
  ) {}
  /** Authorize the owner and atomically journal available-to-reserved movement with its allocation. */
  reserve(input: ReserveWalletFundsInput): Promise<WalletReceipt> {
    const value = money(input.value.amountMinorUnits, input.value.currency);
    assertReference(input.actorId);
    assertReference(input.requestKey);
    assertReference(input.paymentReference);
    return this.wallets.executeOnce(
      {
        requestScope: `customer:${input.actorId}`,
        requestKey: input.requestKey,
        requestFingerprint: JSON.stringify([
          'reserve',
          input.walletId,
          input.paymentReference,
          value.currency,
          value.amountMinorUnits.toString(),
        ]),
      },
      async (transaction, operationId) => {
        const [wallet] = await transaction.lockWallets([input.walletId]);
        if (!wallet) {
          throw new WalletError('WALLET_NOT_FOUND');
        }
        assertWalletOwner(wallet, input.actorId);
        input.validateAuthorization?.();
        assertCanSpend(wallet, value);
        await transaction.createReservation({
          id: operationId,
          walletId: wallet.id,
          paymentReference: input.paymentReference,
          ...value,
          reservationStatus: 'reserved',
        });
        return transaction.postJournal(operationId, {
          journalKind: 'reserve',
          currency: value.currency,
          reservationId: operationId,
          entries: [
            {
              accountId: wallet.availableAccountId,
              side: 'debit',
              amountMinorUnits: value.amountMinorUnits,
            },
            {
              accountId: wallet.reservedAccountId,
              side: 'credit',
              amountMinorUnits: value.amountMinorUnits,
            },
          ],
        });
      },
    );
  }
  /** Preserve unknown outcomes and held money; successful replay returns the original receipt. */
  async settle(input: {
    readonly reservationId: string;
    readonly evidenceReference: string;
  }): Promise<WalletReceipt> {
    assertReference(input.evidenceReference);
    if (!this.verification) {
      throw new WalletError('VERIFICATION_UNAVAILABLE');
    }
    const outcome = await this.verification.verifyOutcome(
      input.evidenceReference,
    );
    if (outcome.outcome === 'unknown') {
      throw new WalletError('OUTCOME_UNCONFIRMED');
    }
    if (outcome.outcome === 'failed' && !outcome.fundsSafeToRelease) {
      throw new WalletError('OUTCOME_UNCONFIRMED');
    }
    assertReference(outcome.paymentReference);
    assertReference(outcome.evidenceReference);
    const financialFingerprint =
      outcome.outcome === 'succeeded'
        ? [
            outcome.principal.currency,
            outcome.principal.amountMinorUnits.toString(),
            outcome.feeMinorUnits.toString(),
            outcome.partnerAccountId,
            outcome.feeAccountId,
          ]
        : [];
    return this.wallets.executeOnce(
      {
        requestScope: `reservation:${input.reservationId}`,
        requestKey: 'resolution',
        requestFingerprint: JSON.stringify([
          outcome.outcome,
          outcome.paymentReference,
          ...financialFingerprint,
        ]),
      },
      async (transaction, operationId) => {
        const reservation = await transaction.lockReservation(
          input.reservationId,
        );
        assertReservationOpen(reservation);
        if (reservation.paymentReference !== outcome.paymentReference) {
          throw new WalletError('INVALID_EVIDENCE');
        }
        const [wallet] = await transaction.lockWallets([reservation.walletId]);
        if (!wallet) {
          throw new WalletError('WALLET_NOT_FOUND');
        }
        if (
          outcome.outcome === 'succeeded' &&
          outcome.principal.currency !== reservation.currency
        ) {
          throw new WalletError('CURRENCY_MISMATCH');
        }
        // Existing obligations must resolve even if new spending is frozen after reservation.
        const credits: LedgerEntry[] =
          outcome.outcome === 'failed'
            ? [
                {
                  accountId: wallet.availableAccountId,
                  side: 'credit',
                  amountMinorUnits: reservation.amountMinorUnits,
                },
              ]
            : await settlementCredits(transaction, outcome);
        const total = credits.reduce(
          (sum, entry) => sum + entry.amountMinorUnits,
          0n,
        );
        if (total !== reservation.amountMinorUnits) {
          throw new WalletError('INVALID_EVIDENCE');
        }
        const isCaptured = outcome.outcome === 'succeeded';
        await transaction.resolveReservation(
          reservation.id,
          isCaptured ? 'captured' : 'released',
        );
        return transaction.postJournal(operationId, {
          journalKind: isCaptured ? 'capture' : 'release',
          currency: reservation.currency,
          reservationId: reservation.id,
          evidenceReference: outcome.evidenceReference,
          entries: [
            {
              accountId: wallet.reservedAccountId,
              side: 'debit',
              amountMinorUnits: reservation.amountMinorUnits,
            },
            ...credits,
          ],
        });
      },
    );
  }
}
