/** Verify existing users receive complete wallets without altering existing funds, and that retries/concurrent runs preserve ledger invariants. */
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { sql } from 'kysely';
import {
  startWalletTestDatabase,
  type WalletTestDatabase,
} from '../../../../packages/payments-runtime/tests/support/wallet-test-database.js';
import { createDatabase } from '@axiapay/payments-runtime/infrastructure/database/create-database';
import { WalletDataSource } from '@axiapay/payments-runtime/modules/wallets/data-sources/wallet.data-source';
import { WalletRepositoryImpl } from '@axiapay/payments-runtime/modules/wallets/repositories/wallet.repository.impl';
import { PostgresAccountWalletProvisioningRepository } from '../../src/modules/authentication/repositories/postgres-account-wallet-provisioning.repository.js';
import { VerifiedWalletBackfillService } from '../../src/modules/authentication/services/verified-wallet-backfill.service.js';

let storage: WalletTestDatabase;
let service: VerifiedWalletBackfillService;
let wallets: WalletRepositoryImpl;

beforeAll(async () => {
  storage = await startWalletTestDatabase();
  await sql`grant select, update on auth_accounts to wallet_runtime`.execute(
    storage.administrator,
  );
  wallets = new WalletRepositoryImpl(new WalletDataSource(storage.database));
  service = new VerifiedWalletBackfillService(
    new PostgresAccountWalletProvisioningRepository(storage.database),
  );
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => storage?.stop());

/** Insert synthetic identities representing verified users registered before automatic wallet provisioning existed. */
async function legacyAccounts(count: number): Promise<readonly string[]> {
  const ids = Array.from({ length: count }, () => randomUUID());
  await storage.administrator
    .insertInto('auth_accounts')
    .values(
      ids.map((id) => ({
        id,
        contact_kind: 'email',
        contact_value: `${id}@example.com`,
        password_hash: null,
        credential_version: 0,
        created_at: new Date(),
        verified_at: new Date(),
        disabled_at: null,
      })),
    )
    .execute();
  return ids;
}

describe('verified wallet backfill', () => {
  it('pages over existing users and preserves a funded, frozen wallet and other-currency wallets across reruns', async () => {
    const ids = await legacyAccounts(105);
    const existing = await wallets.createWallet(ids[0]!, 'NGN');
    const otherCurrency = await wallets.createWallet(ids[1]!, 'USD');
    const partnerId = randomUUID();
    await storage.administrator
      .insertInto('ledger_accounts')
      .values({
        id: partnerId,
        account_code: `backfill-fixture:${partnerId}`,
        account_kind: 'partner_funds',
        wallet_id: null,
        currency: 'NGN',
      })
      .execute();
    await wallets.executeOnce(
      {
        requestScope: 'backfill-fixture',
        requestKey: randomUUID(),
        requestFingerprint: 'fund-original-wallet',
      },
      async (transaction, operationId) => {
        await transaction.lockWallets([existing.id]);
        return transaction.postJournal(operationId, {
          journalKind: 'funding',
          currency: 'NGN',
          evidenceReference: 'backfill-fixture-funding',
          entries: [
            { accountId: partnerId, side: 'debit', amountMinorUnits: 12_345n },
            {
              accountId: existing.availableAccountId,
              side: 'credit',
              amountMinorUnits: 12_345n,
            },
          ],
        });
      },
    );
    await storage.database
      .updateTable('wallets')
      .set({ wallet_status: 'frozen' })
      .where('id', '=', existing.id)
      .execute();
    const before = await wallets.getWallet(existing.id);
    const journals = await storage.database
      .selectFrom('ledger_journals')
      .selectAll()
      .execute();
    expect(await service.run()).toEqual({ processedAccounts: 105 });
    expect(await service.run()).toEqual({ processedAccounts: 105 });
    expect(await wallets.getWallet(existing.id)).toEqual(before);
    expect(await wallets.getWallet(otherCurrency.id)).toEqual(otherCurrency);
    expect(
      await storage.database
        .selectFrom('ledger_journals')
        .selectAll()
        .execute(),
    ).toEqual(journals);
    const rows = await sql<{
      wallets: number;
      accounts: number;
      zero_balance_accounts: number;
    }>`select (select count(*)::int from wallets where owner_id in (${sql.join(ids)}) and currency = 'NGN') as wallets, count(*)::int as accounts, count(*) filter (where b.debits_minor_units = 0 and b.credits_minor_units = 0)::int as zero_balance_accounts from ledger_accounts a inner join ledger_balances b on b.account_id = a.id inner join wallets w on w.id = a.wallet_id where w.owner_id in (${sql.join(ids)}) and w.currency = 'NGN'`.execute(
      storage.database,
    );
    expect(rows.rows[0]).toEqual({
      wallets: 105,
      accounts: 210,
      zero_balance_accounts: 209,
    });
  });

  it('supports concurrent backfills with independent database pools without duplicate wallets or liability accounts', async () => {
    const ids = await legacyAccounts(3);
    const otherDatabase = createDatabase(storage.connectionString);
    try {
      const otherService = new VerifiedWalletBackfillService(
        new PostgresAccountWalletProvisioningRepository(otherDatabase),
      );
      await Promise.all([service.run(), otherService.run()]);
    } finally {
      await otherDatabase.destroy();
    }
    const created = await storage.database
      .selectFrom('wallets')
      .select(['id', 'owner_id'])
      .where('owner_id', 'in', ids)
      .where('currency', '=', 'NGN')
      .execute();
    expect(created).toHaveLength(3);
    const accounts = await storage.database
      .selectFrom('ledger_accounts')
      .select('id')
      .where(
        'wallet_id',
        'in',
        created.map((wallet) => wallet.id),
      )
      .execute();
    expect(accounts).toHaveLength(6);
  });

  it('rolls back an interrupted account provision and resumes safely on the next run', async () => {
    const [accountId] = await legacyAccounts(1);
    const create = WalletRepositoryImpl.prototype.createWallet;
    const failure = vi
      .spyOn(WalletRepositoryImpl.prototype, 'createWallet')
      .mockImplementation(async function (
        this: WalletRepositoryImpl,
        ownerId,
        currency,
      ) {
        const wallet = await create.call(this, ownerId, currency);
        if (ownerId === accountId) {
          throw new Error('fixture interruption after wallet provisioning');
        }
        return wallet;
      });
    await expect(service.run()).rejects.toThrow('fixture interruption');
    expect(
      await storage.database
        .selectFrom('wallets')
        .select('id')
        .where('owner_id', '=', accountId!)
        .execute(),
    ).toEqual([]);
    failure.mockRestore();
    await service.run();
    const created = await storage.database
      .selectFrom('wallets')
      .select('id')
      .where('owner_id', '=', accountId!)
      .execute();
    expect(created).toHaveLength(1);
    expect(
      await storage.database
        .selectFrom('ledger_accounts')
        .select('id')
        .where('wallet_id', '=', created[0]!.id)
        .execute(),
    ).toHaveLength(2);
  });
});
