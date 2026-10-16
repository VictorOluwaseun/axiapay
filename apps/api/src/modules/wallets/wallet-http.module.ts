import { Module } from '@nestjs/common';
import { WalletModule } from '@axiapay/payments-runtime/modules/wallets/wallet.module';
import { AuthenticationModule } from '../authentication/authentication.module.js';
import { WalletController } from './controllers/wallet.controller.js';
import { WalletSummaryCacheModule } from './wallet-summary-cache.module.js';
import { WALLET_SUMMARY } from './wallet-summary.tokens.js';

/** Single configured wallet-module identity shared by HTTP composition and module-composition tests. */
export const walletHttpCoreModule = WalletModule.withSummaryCache({
  imports: [WalletSummaryCacheModule],
  cacheToken: WALLET_SUMMARY.cache,
});

/** Expose authenticated operations through the shared WalletService, binding API display caching at the composition boundary. */
@Module({
  imports: [AuthenticationModule, walletHttpCoreModule],
  controllers: [WalletController],
})
export class WalletHttpModule {}
