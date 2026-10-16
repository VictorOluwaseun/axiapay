import type { WalletRepository } from '@axiapay/payments-runtime/modules/wallets/repositories/contracts/wallet.repository';
import type { AuthenticationRepository } from './authentication.repository.js';

/** Coordinate code redemption and wallet provisioning without exposing storage clients to services. */
export interface CodeRedemptionRepository {
  /**
   * Bind authentication and wallet creation to one transaction. Returned failures commit attempt
   * counters; exceptions roll back account activation, wallet provisioning, sessions and code use.
   * Reads bypass cache and no external delivery may run inside the callback.
   */
  transaction<Result>(
    work: (
      authentication: AuthenticationRepository,
      wallets: Pick<WalletRepository, 'createWallet'>,
    ) => Promise<Result>,
  ): Promise<Result>;
}
