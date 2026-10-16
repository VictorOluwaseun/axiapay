/** Administrative persistence boundary for resumable wallet provisioning; wallet creation must reuse the ledger's atomic rules. */
export interface AccountWalletProvisioningRepository {
  /** Read a bounded UUID-ordered page without exposing contacts or credential material. */
  findVerifiedAccountIds(
    afterAccountId: string | null,
    limit: number,
  ): Promise<readonly string[]>;
  /** Lock/recheck the account and atomically provision or retain its wallet; return false if the account no longer exists. */
  ensureWallet(accountId: string, currency: string): Promise<boolean>;
}
