import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { defer, lastValueFrom } from 'rxjs';
import type { WalletSummaryInvalidationRepository } from '../../modules/wallets/repositories/contracts/wallet-summary-invalidation.repository.js';
import { WALLET_SUMMARY } from '../../modules/wallets/wallet-summary.tokens.js';

/** Deliver committed wallet invalidations in API infrastructure before returning mutation results, including uncertain outcomes. */
@Injectable()
export class WalletSummaryInvalidationInterceptor implements NestInterceptor {
  /** Depend on bounded delivery only; SQL, cache policy and retries remain repository responsibilities. */
  constructor(
    @Inject(WALLET_SUMMARY.invalidations)
    private readonly invalidations: WalletSummaryInvalidationRepository,
  ) {}

  /** Wait after handler completion or failure because a reservation may have committed before an external call failed. */
  intercept(context: ExecutionContext, next: CallHandler) {
    const method = context
      .switchToHttp()
      .getRequest<{ method: string }>().method;
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      return next.handle();
    }
    return defer(async () => {
      try {
        return await lastValueFrom(next.handle());
      } finally {
        await this.invalidations.flush();
      }
    });
  }
}
