import { Module } from '@nestjs/common';
import { AuthenticationModule } from '../authentication/authentication.module.js';
import { WalletModule } from '@axiapay/backend/modules/wallets/wallet.module';
import { WalletController } from './controllers/wallet.controller.js';

/** Expose authenticated customer operations while keeping the reusable core independent of HTTP and session infrastructure. */
@Module({
  imports: [AuthenticationModule, WalletModule],
  controllers: [WalletController],
})
export class WalletHttpModule {}
