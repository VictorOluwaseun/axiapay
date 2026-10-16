/** Verify real PostgreSQL locking, posting invariants and recovery through wallet services. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  startWalletTestDatabase,
  type WalletTestDatabase,
} from '../../../../packages/backend/tests/support/wallet-test-database.js';
import { Test, type TestingModule } from '@nestjs/testing';
import { WalletModule } from '@axiapay/backend/modules/wallets/wallet.module';
import { WalletService } from '@axiapay/backend/modules/wallets/services/wallet.service';
import { DatabaseConnection } from '@axiapay/backend/infrastructure/database/database.module';
import { money } from '@axiapay/backend/modules/wallets/domain/money';
import type { Wallet } from '@axiapay/backend/modules/wallets/domain/wallet';
import type {
  ConfirmedFunding,
  VerifiedPaymentOutcome,
} from '@axiapay/backend/modules/wallets/ports/wallet-verification';

let testDatabase: WalletTestDatabase;
const modules: TestingModule[] = [];
beforeAll(async () => {
  testDatabase = await startWalletTestDatabase();
});
afterAll(async () => {
  await Promise.all(modules.map((module) => module.close()));
  await testDatabase?.stop();
});

/** Create isolated owners/system accounts and explicitly controlled verifier responses for each scenario. */
async function fixture() {
  const partnerAccountId = randomUUID();
  const feeAccountId = randomUUID();
  await testDatabase.administrator
    .insertInto('ledger_accounts')
    .values([
      {
        id: partnerAccountId,
        account_code: `partner:${partnerAccountId}`,
        account_kind: 'partner_funds',
        currency: 'NGN',
        wallet_id: null,
      },
      {
        id: feeAccountId,
        account_code: `fees:${feeAccountId}`,
        account_kind: 'fee_income',
        currency: 'NGN',
        wallet_id: null,
      },
    ])
    .execute();
  const fundingEvidence = new Map<string, ConfirmedFunding>();
  const outcomeEvidence = new Map<string, VerifiedPaymentOutcome>();
  const module = await Test.createTestingModule({
    imports: [
      WalletModule.register({
        funding: {
          /** Reject evidence the test has not explicitly verified. */
          async verifyFunding(reference) {
            const funding = fundingEvidence.get(reference);
            if (!funding) {
              throw new Error('unverified funding');
            }
            return funding;
          },
        },
        paymentOutcome: {
          /** Return the controlled provider outcome without converting uncertainty into failure. */
          async verifyOutcome(reference) {
            const outcome = outcomeEvidence.get(reference);
            if (!outcome) {
              throw new Error('unverified outcome');
            }
            return outcome;
          },
        },
      }),
    ],
  })
    .overrideProvider(DatabaseConnection)
    .useValue({ database: testDatabase.database })
    .compile();
  modules.push(module);
  const service = module.get(WalletService);
  const application = {
    createWallet: service.createWallet.bind(service),
    getWalletBalance: service.getWalletBalance.bind(service),
    transferBetweenWallets: service.transferBetweenWallets.bind(service),
    reserveWalletFunds: service.reserveWalletFunds.bind(service),
    confirmWalletFunding: service.confirmWalletFunding.bind(service),
    settleWalletReservation: service.settleWalletReservation.bind(service),
  };
  const ownerId = randomUUID();
  const wallet = await application.createWallet({
    actorId: ownerId,
    currency: 'NGN',
  });
  return {
    ...application,
    wallet,
    ownerId,
    partnerAccountId,
    feeAccountId,
    fundingEvidence,
    outcomeEvidence,
    /** Supply settled funding evidence for this fixture's partner and selected wallet. */
    async fund(
      amountMinorUnits: bigint,
      target: Wallet = wallet,
      externalMovementId = randomUUID(),
    ) {
      const evidenceReference = randomUUID();
      fundingEvidence.set(evidenceReference, {
        walletId: target.id,
        partnerAccountId,
        externalMovementId,
        evidenceReference,
        value: money(amountMinorUnits, target.currency),
      });
      return application.confirmWalletFunding(evidenceReference);
    },
    /** Accept a payment and reserve its full authorized debit. */
    async reserve(
      amountMinorUnits: bigint,
      paymentReference = randomUUID(),
      requestKey = randomUUID(),
    ) {
      const receipt = await application.reserveWalletFunds({
        actorId: ownerId,
        walletId: wallet.id,
        requestKey,
        paymentReference,
        value: money(amountMinorUnits, 'NGN'),
      });
      return {
        reservationId: receipt.reservationId!,
        paymentReference,
        receipt,
      };
    },
    /** Supply settlement evidence through the same port used by real provider adapters. */
    async settle(reservationId: string, outcome: VerifiedPaymentOutcome) {
      const evidenceReference = randomUUID();
      outcomeEvidence.set(evidenceReference, outcome);
      return application.settleWalletReservation({
        reservationId,
        evidenceReference,
      });
    },
    /** Read owner-authorized current balances. */
    balance() {
      return application.getWalletBalance({
        actorId: ownerId,
        walletId: wallet.id,
      });
    },
  };
}

describe('wallet application and PostgreSQL ledger', () => {
  it('creates exactly one wallet and both empty accounts during concurrent provisioning', async () => {
    const context = await fixture();
    const ownerId = randomUUID();
    const wallets = await Promise.all(
      Array.from({ length: 8 }, () =>
        context.createWallet({ actorId: ownerId, currency: 'NGN' }),
      ),
    );
    expect(new Set(wallets.map((wallet) => wallet.id)).size).toBe(1);
    expect(wallets[0]).toMatchObject({
      availableMinorUnits: 0n,
      reservedMinorUnits: 0n,
    });
    const accounts = await testDatabase.database
      .selectFrom('ledger_accounts')
      .selectAll()
      .where('wallet_id', '=', wallets[0]!.id)
      .execute();
    expect(accounts).toHaveLength(2);
  });

  it('deduplicates different notifications for one economic deposit, preserving exact large amounts', async () => {
    const context = await fixture();
    const amount = 9_007_199_254_740_993n;
    const movementId = randomUUID();
    const receipts = await Promise.all(
      Array.from({ length: 8 }, () =>
        context.fund(amount, context.wallet, movementId),
      ),
    );
    expect(new Set(receipts.map((receipt) => receipt.operationId)).size).toBe(
      1,
    );
    expect((await context.balance()).availableMinorUnits).toBe(amount);
    await expect(
      context.fund(amount + 1n, context.wallet, movementId),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const outbox = await testDatabase.database
      .selectFrom('wallet_outbox_events')
      .selectAll()
      .where('id', '=', receipts[0]!.operationId)
      .execute();
    expect(outbox).toHaveLength(1);
  });

  it('does not post unverified funding', async () => {
    const context = await fixture();
    await expect(context.confirmWalletFunding('untrusted')).rejects.toThrow(
      'unverified funding',
    );
    expect((await context.balance()).availableMinorUnits).toBe(0n);
  });

  it('lets only one concurrent payment reserve the same available money', async () => {
    const context = await fixture();
    await context.fund(1_000_000n);
    const results = await Promise.allSettled([
      context.reserve(700_000n),
      context.reserve(700_000n),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === 'rejected'),
    ).toMatchObject({ reason: { code: 'INSUFFICIENT_FUNDS' } });
    expect(await context.balance()).toMatchObject({
      availableMinorUnits: 300_000n,
      reservedMinorUnits: 700_000n,
    });
  });

  it('replays one reservation across duplicate submissions and rejects changed terms', async () => {
    const context = await fixture();
    await context.fund(100n);
    const paymentReference = randomUUID();
    const requestKey = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        context.reserve(60n, paymentReference, requestKey),
      ),
    );
    expect(new Set(results.map((result) => result.reservationId)).size).toBe(1);
    await expect(
      context.reserve(61n, paymentReference, requestKey),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await context.balance()).toMatchObject({
      availableMinorUnits: 40n,
      reservedMinorUnits: 60n,
    });
  });

  it('captures verified principal and fee exactly once, including duplicate worker delivery', async () => {
    const context = await fixture();
    await context.fund(1_000_000n);
    const reservation = await context.reserve(205_000n);
    const outcome: VerifiedPaymentOutcome = {
      outcome: 'succeeded',
      paymentReference: reservation.paymentReference,
      evidenceReference: 'verified-bank-debit',
      partnerAccountId: context.partnerAccountId,
      feeAccountId: context.feeAccountId,
      principal: money(200_000n, 'NGN'),
      feeMinorUnits: 5_000n,
    };
    const receipts = await Promise.all(
      Array.from({ length: 5 }, () =>
        context.settle(reservation.reservationId, outcome),
      ),
    );
    expect(new Set(receipts.map((receipt) => receipt.operationId)).size).toBe(
      1,
    );
    expect(await context.balance()).toMatchObject({
      availableMinorUnits: 795_000n,
      reservedMinorUnits: 0n,
    });
    const fees = await testDatabase.database
      .selectFrom('ledger_balances')
      .selectAll()
      .where('account_id', '=', context.feeAccountId)
      .executeTakeFirstOrThrow();
    expect(
      BigInt(fees.credits_minor_units) - BigInt(fees.debits_minor_units),
    ).toBe(5_000n);
    await expect(
      context.settle(reservation.reservationId, {
        outcome: 'failed',
        fundsSafeToRelease: true,
        paymentReference: reservation.paymentReference,
        evidenceReference: 'contradictory-event',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('retains funds through uncertainty and a failed payout whose partner debit is outstanding', async () => {
    const context = await fixture();
    await context.fund(100n);
    const reservation = await context.reserve(80n);
    await expect(
      context.settle(reservation.reservationId, {
        outcome: 'unknown',
        paymentReference: reservation.paymentReference,
      }),
    ).rejects.toMatchObject({ code: 'OUTCOME_UNCONFIRMED' });
    await expect(
      context.settle(reservation.reservationId, {
        outcome: 'failed',
        fundsSafeToRelease: false,
        paymentReference: reservation.paymentReference,
        evidenceReference: 'pending-return',
      }),
    ).rejects.toMatchObject({ code: 'OUTCOME_UNCONFIRMED' });
    expect(await context.balance()).toMatchObject({
      availableMinorUnits: 20n,
      reservedMinorUnits: 80n,
    });
    await context.settle(reservation.reservationId, {
      outcome: 'failed',
      fundsSafeToRelease: true,
      paymentReference: reservation.paymentReference,
      evidenceReference: 'verified-no-debit',
    });
    expect(await context.balance()).toMatchObject({
      availableMinorUnits: 100n,
      reservedMinorUnits: 0n,
    });
  });

  it('binds settlement evidence to its payment and exact authorized total', async () => {
    const context = await fixture();
    await context.fund(100n);
    const reservation = await context.reserve(80n);
    await expect(
      context.settle(reservation.reservationId, {
        outcome: 'failed',
        fundsSafeToRelease: true,
        paymentReference: randomUUID(),
        evidenceReference: 'other-payment',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' });
    await expect(
      context.settle(reservation.reservationId, {
        outcome: 'succeeded',
        paymentReference: reservation.paymentReference,
        evidenceReference: 'wrong-amount',
        partnerAccountId: context.partnerAccountId,
        feeAccountId: null,
        principal: money(81n, 'NGN'),
        feeMinorUnits: 0n,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' });
    expect(await context.balance()).toMatchObject({
      availableMinorUnits: 20n,
      reservedMinorUnits: 80n,
    });
  });

  it('enforces ownership, wallet restrictions and currency on internal transfers', async () => {
    const context = await fixture();
    await context.fund(100n);
    const destination = await context.createWallet({
      actorId: randomUUID(),
      currency: 'NGN',
    });
    const transfer = {
      actorId: context.ownerId,
      sourceWalletId: context.wallet.id,
      destinationWalletId: destination.id,
      requestKey: randomUUID(),
      value: money(30n, 'NGN'),
    };
    await expect(
      context.getWalletBalance({
        actorId: 'another-customer',
        walletId: context.wallet.id,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      context.transferBetweenWallets({
        ...transfer,
        actorId: 'another-customer',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const foreign = await context.createWallet({
      actorId: randomUUID(),
      currency: 'USD',
    });
    await expect(
      context.transferBetweenWallets({
        ...transfer,
        destinationWalletId: foreign.id,
      }),
    ).rejects.toMatchObject({ code: 'CURRENCY_MISMATCH' });
    await testDatabase.administrator
      .updateTable('wallets')
      .set({ wallet_status: 'frozen' })
      .where('id', '=', context.wallet.id)
      .execute();
    await expect(
      context.transferBetweenWallets(transfer),
    ).rejects.toMatchObject({ code: 'WALLET_RESTRICTED' });
    expect((await context.balance()).availableMinorUnits).toBe(100n);
  });

  it('transfers in opposite directions without deadlock and conserves total customer funds', async () => {
    const context = await fixture();
    const destination = await context.createWallet({
      actorId: randomUUID(),
      currency: 'NGN',
    });
    await context.fund(100n);
    await context.fund(100n, destination);
    await Promise.all([
      context.transferBetweenWallets({
        actorId: context.ownerId,
        sourceWalletId: context.wallet.id,
        destinationWalletId: destination.id,
        requestKey: randomUUID(),
        value: money(70n, 'NGN'),
      }),
      context.transferBetweenWallets({
        actorId: destination.ownerId,
        sourceWalletId: destination.id,
        destinationWalletId: context.wallet.id,
        requestKey: randomUUID(),
        value: money(20n, 'NGN'),
      }),
    ]);
    expect((await context.balance()).availableMinorUnits).toBe(50n);
    expect(
      (
        await context.getWalletBalance({
          actorId: destination.ownerId,
          walletId: destination.id,
        })
      ).availableMinorUnits,
    ).toBe(150n);
  });

  it('rolls back a failed journal, its request claim, balance projection and outbox together', async () => {
    const context = await fixture();
    const operationId = randomUUID();
    await expect(
      testDatabase.database.transaction().execute(async (transaction) => {
        await transaction
          .insertInto('wallet_operations')
          .values({
            id: operationId,
            request_scope: 'test',
            request_key: operationId,
            request_fingerprint: 'unbalanced',
          })
          .execute();
        await transaction
          .insertInto('ledger_journals')
          .values({
            id: operationId,
            journal_kind: 'funding',
            currency: 'NGN',
            reservation_id: null,
            evidence_reference: 'fixture',
          })
          .execute();
        await transaction
          .insertInto('ledger_entries')
          .values([
            {
              journal_id: operationId,
              line_number: 1,
              account_id: context.partnerAccountId,
              currency: 'NGN',
              entry_side: 'debit',
              amount_minor_units: 99n,
            },
            {
              journal_id: operationId,
              line_number: 2,
              account_id: context.wallet.availableAccountId,
              currency: 'NGN',
              entry_side: 'credit',
              amount_minor_units: 100n,
            },
          ])
          .execute();
        await transaction
          .insertInto('wallet_outbox_events')
          .values({ id: operationId, delivered_at: null })
          .execute();
      }),
    ).rejects.toThrow('journal must contain balanced entries');
    expect((await context.balance()).availableMinorUnits).toBe(0n);
    expect(
      await testDatabase.database
        .selectFrom('wallet_operations')
        .select('id')
        .where('id', '=', operationId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await testDatabase.database
        .selectFrom('wallet_outbox_events')
        .select('id')
        .where('id', '=', operationId)
        .execute(),
    ).toHaveLength(0);
  });

  it('rejects direct balance edits, mutations of history and appends to a committed journal', async () => {
    const context = await fixture();
    const receipt = await context.fund(100n);
    await expect(
      testDatabase.database
        .updateTable('ledger_balances')
        .set({ balance_version: 500 })
        .where('account_id', '=', context.wallet.availableAccountId)
        .execute(),
    ).rejects.toThrow('balances can only change through ledger entries');
    // Even the migration owner cannot accidentally rewrite history while protections are enabled.
    await expect(
      testDatabase.administrator
        .updateTable('ledger_entries')
        .set({ amount_minor_units: 500n })
        .where('journal_id', '=', receipt.operationId)
        .execute(),
    ).rejects.toThrow('wallet history is immutable');
    await expect(
      testDatabase.administrator
        .deleteFrom('ledger_journals')
        .where('id', '=', receipt.operationId)
        .execute(),
    ).rejects.toThrow('wallet history is immutable');
    await expect(
      testDatabase.database
        .insertInto('ledger_entries')
        .values({
          journal_id: receipt.operationId,
          line_number: 3,
          account_id: context.wallet.availableAccountId,
          currency: 'NGN',
          entry_side: 'credit',
          amount_minor_units: 100n,
        })
        .execute(),
    ).rejects.toThrow('cannot append to a committed journal');
    expect((await context.balance()).availableMinorUnits).toBe(100n);
  });

  it('reconciles all stored balances to immutable entries and outstanding reservation allocations', async () => {
    const context = await fixture();
    await context.fund(1_000n);
    await context.reserve(300n);
    const mismatch = await sql<{ account_id: string }>`
      select b.account_id from ledger_balances b left join ledger_entries e on e.account_id = b.account_id
      group by b.account_id, b.debits_minor_units, b.credits_minor_units
      having b.debits_minor_units <> coalesce(sum(e.amount_minor_units) filter (where e.entry_side = 'debit'), 0)
        or b.credits_minor_units <> coalesce(sum(e.amount_minor_units) filter (where e.entry_side = 'credit'), 0)
    `.execute(testDatabase.database);
    expect(mismatch.rows).toHaveLength(0);
    const outstanding = await testDatabase.database
      .selectFrom('wallet_reservations')
      .select('amount_minor_units')
      .where('wallet_id', '=', context.wallet.id)
      .where('reservation_status', '=', 'reserved')
      .execute();
    expect(
      outstanding.reduce(
        (sum, reservation) => sum + BigInt(reservation.amount_minor_units),
        0n,
      ),
    ).toBe((await context.balance()).reservedMinorUnits);
  });

  it('serializes a transfer racing a reservation against the same funds', async () => {
    const context = await fixture();
    await context.fund(100n);
    const destination = await context.createWallet({
      actorId: randomUUID(),
      currency: 'NGN',
    });
    const results = await Promise.allSettled([
      context.reserve(70n),
      context.transferBetweenWallets({
        actorId: context.ownerId,
        sourceWalletId: context.wallet.id,
        destinationWalletId: destination.id,
        requestKey: randomUUID(),
        value: money(70n, 'NGN'),
      }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect((await context.balance()).availableMinorUnits).toBe(30n);
    const source = await context.balance();
    const recipient = await context.getWalletBalance({
      actorId: destination.ownerId,
      walletId: destination.id,
    });
    expect(
      source.availableMinorUnits +
        source.reservedMinorUnits +
        recipient.availableMinorUnits,
    ).toBe(100n);
  });

  it('settles an existing reservation after a wallet freeze without authorizing new spending', async () => {
    const context = await fixture();
    await context.fund(100n);
    const reservation = await context.reserve(80n);
    await testDatabase.administrator
      .updateTable('wallets')
      .set({ wallet_status: 'frozen' })
      .where('id', '=', context.wallet.id)
      .execute();
    await context.settle(reservation.reservationId, {
      outcome: 'succeeded',
      paymentReference: reservation.paymentReference,
      evidenceReference: 'verified-zero-fee-payment',
      partnerAccountId: context.partnerAccountId,
      feeAccountId: null,
      principal: money(80n, 'NGN'),
      feeMinorUnits: 0n,
    });
    expect(await context.balance()).toMatchObject({
      availableMinorUnits: 20n,
      reservedMinorUnits: 0n,
      walletStatus: 'frozen',
    });
    await expect(context.reserve(1n)).rejects.toMatchObject({
      code: 'WALLET_RESTRICTED',
    });
  });

  it('prevents a duplicate deposit from being redirected to another wallet', async () => {
    const context = await fixture();
    const destination = await context.createWallet({
      actorId: randomUUID(),
      currency: 'NGN',
    });
    const movementId = randomUUID();
    await context.fund(100n, context.wallet, movementId);
    await expect(
      context.fund(100n, destination, movementId),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(
      (
        await context.getWalletBalance({
          actorId: destination.ownerId,
          walletId: destination.id,
        })
      ).availableMinorUnits,
    ).toBe(0n);
  });

  it('rejects incomplete wallet provisioning and orphaned idempotency claims at commit', async () => {
    await expect(
      testDatabase.database
        .insertInto('wallets')
        .values({ id: randomUUID(), owner_id: randomUUID(), currency: 'NGN' })
        .execute(),
    ).rejects.toThrow('wallet must have available and reserved accounts');
    await expect(
      testDatabase.database
        .insertInto('wallet_operations')
        .values({
          id: randomUUID(),
          request_scope: 'test',
          request_key: randomUUID(),
          request_fingerprint: 'no journal',
        })
        .execute(),
    ).rejects.toThrow('wallet operation requires a journal and outbox event');
  });

  it('rejects overdrafts and mixed currencies even when a caller bypasses application policies', async () => {
    const context = await fixture();
    const destination = await context.createWallet({
      actorId: randomUUID(),
      currency: 'NGN',
    });
    await context.fund(10n);
    /** Deliberately bypass the services to exercise independent database constraints. */
    const unsafeTransfer = (currency: string, amountMinorUnits: bigint) =>
      testDatabase.database.transaction().execute(async (transaction) => {
        const operationId = randomUUID();
        await transaction
          .insertInto('wallet_operations')
          .values({
            id: operationId,
            request_scope: 'test',
            request_key: operationId,
            request_fingerprint: 'invalid-transfer',
          })
          .execute();
        await transaction
          .insertInto('ledger_journals')
          .values({
            id: operationId,
            journal_kind: 'transfer',
            currency,
            reservation_id: null,
            evidence_reference: null,
          })
          .execute();
        await transaction
          .insertInto('ledger_entries')
          .values([
            {
              journal_id: operationId,
              line_number: 1,
              account_id: context.wallet.availableAccountId,
              currency,
              entry_side: 'debit',
              amount_minor_units: amountMinorUnits,
            },
            {
              journal_id: operationId,
              line_number: 2,
              account_id: destination.availableAccountId,
              currency,
              entry_side: 'credit',
              amount_minor_units: amountMinorUnits,
            },
          ])
          .execute();
        await transaction
          .insertInto('wallet_outbox_events')
          .values({ id: operationId, delivered_at: null })
          .execute();
      });
    await expect(unsafeTransfer('NGN', 11n)).rejects.toMatchObject({
      code: '23514',
    });
    await expect(unsafeTransfer('USD', 1n)).rejects.toMatchObject({
      code: '23503',
    });
    expect((await context.balance()).availableMinorUnits).toBe(10n);
  });
});
