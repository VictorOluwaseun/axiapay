import { ApiProperty } from '@nestjs/swagger';
import { HttpErrorResponseDto } from '../../../shared/http/http-error-response.dto.js';
import type { Wallet } from '@axiapay/backend/modules/wallets/domain/wallet';

/** Public wallet snapshot excludes ledger account IDs and serializes every monetary value exactly. */
export class WalletBalanceResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ example: 'NGN' })
  readonly currency!: string;

  @ApiProperty({ enum: ['active', 'frozen', 'closed'] })
  readonly walletStatus!: Wallet['walletStatus'];

  @ApiProperty({ type: String, pattern: '^[0-9]+$', example: '12500' })
  readonly availableMinorUnits!: string;

  @ApiProperty({ type: String, pattern: '^[0-9]+$', example: '2500' })
  readonly reservedMinorUnits!: string;

  @ApiProperty({ type: String, pattern: '^[0-9]+$', example: '15000' })
  readonly totalMinorUnits!: string;

  /** Project a single committed database snapshot without leaking persistence identities. */
  static fromWallet(wallet: Wallet): WalletBalanceResponseDto {
    return {
      id: wallet.id,
      currency: wallet.currency,
      walletStatus: wallet.walletStatus,
      availableMinorUnits: wallet.availableMinorUnits.toString(),
      reservedMinorUnits: wallet.reservedMinorUnits.toString(),
      totalMinorUnits: (
        wallet.availableMinorUnits + wallet.reservedMinorUnits
      ).toString(),
    };
  }
}

/** Receipt of an atomically committed internal transfer; retries return the same operation ID. */
export class WalletTransferResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly operationId!: string;
}

/** Stable public failure contract, without raw validation inputs or dependency details. */
export class WalletErrorResponseDto extends HttpErrorResponseDto {}
