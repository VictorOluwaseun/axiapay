import { authenticationPolicy } from '../domain/authentication-policy.js';
import type { AccountWalletProvisioningRepository } from '../repositories/contracts/account-wallet-provisioning.repository.js';

/** Ensure the signup wallet for existing verified users in bounded pages; per-account commits make restart and concurrent runs safe. */
export class VerifiedWalletBackfillService {
  /** Keep administrative policy here; repositories own paging, account locking and atomic ledger provisioning. */
  constructor(private readonly accounts: AccountWalletProvisioningRepository) {}

  /** Revisit all verified accounts on each run; existing wallet IDs, statuses, balances and journal history remain unchanged. */
  async run(): Promise<{ readonly processedAccounts: number }> {
    let afterAccountId: string | null = null;
    let processedAccounts = 0;
    while (true) {
      const accountIds = await this.accounts.findVerifiedAccountIds(
        afterAccountId,
        100,
      );
      if (accountIds.length === 0) {
        return { processedAccounts };
      }
      for (const accountId of accountIds) {
        const ensured = await this.accounts.ensureWallet(
          accountId,
          authenticationPolicy.signupWalletCurrency,
        );
        processedAccounts += ensured ? 1 : 0;
      }
      afterAccountId = accountIds.at(-1)!;
    }
  }
}
