import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { plainToInstance, Type } from 'class-transformer';
import {
  IsHash,
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
  validateSync,
} from 'class-validator';
import type { RedisCacheConnection } from '../../../infrastructure/redis/redis-cache-connection.js';
import { RecoverableRedisCache } from '../../../infrastructure/redis/recoverable-redis-cache.js';
import {
  readScript,
  fillScript,
  invalidateScript,
} from '../../../infrastructure/redis/generation-cache-scripts.js';
import type { WalletSummary } from '@axiapay/payments-runtime/modules/wallets/domain/wallet-summary';
import type {
  WalletSummaryFillTicket,
  WalletSummaryLookup,
} from '@axiapay/payments-runtime/modules/wallets/repositories/contracts/wallet-summary-cache';
import type { WalletSummaryCache } from '../repositories/contracts/wallet-summary-cache.js';

/** Validate serialized display amounts at the Redis trust boundary; no internal ledger account identities are stored. */
class StoredWalletSummary {
  @IsUUID() readonly id!: string;
  @IsUUID() readonly ownerId!: string;
  @Matches(/^[A-Z]{3}(?![\s\S])/) readonly currency!: string;
  @IsIn(['active', 'frozen', 'closed'])
  readonly walletStatus!: WalletSummary['walletStatus'];
  @Matches(/^(0|[1-9][0-9]{0,18})(?![\s\S])/)
  readonly availableMinorUnits!: string;
  @Matches(/^(0|[1-9][0-9]{0,18})(?![\s\S])/)
  readonly reservedMinorUnits!: string;
}

/** Signed cache metadata binds a display snapshot to its observed generation and absolute expiry. */
class StoredSnapshot {
  @ValidateNested()
  @Type(() => StoredWalletSummary)
  readonly wallet!: StoredWalletSummary;
  @IsUUID() readonly epoch!: string;
  @IsUUID() readonly generation!: string;
  @IsInt() @Min(1) readonly expiresAtMs!: number;
}

/** Validate the envelope before constant-time MAC comparison and payload deserialization. */
class SignedEnvelope {
  @IsString() @MaxLength(2048) readonly payload!: string;
  @IsHash('sha256') readonly mac!: string;
}

/** Validate untrusted Redis JSON with the installed boundary-validation stack, rejecting surplus properties. */
function decodeRecord<T extends object>(
  type: new () => T,
  encoded: string,
): T | null {
  const parsed: unknown = JSON.parse(encoded);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const value = plainToInstance(type, parsed);
  return validateSync(value, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  }).length === 0
    ? value
    : null;
}

/** Store signed display snapshots for 15 seconds; atomic generation fences reject overlapping stale fills. */
export class RedisWalletSummaryCache
  extends RecoverableRedisCache
  implements WalletSummaryCache
{
  private readonly signingKey: Buffer;

  /** Share a managed, bounded client and domain-separated signing secret; recovery enables reads after replay. */
  constructor(connection: RedisCacheConnection, secret: string) {
    super(connection);
    this.signingKey = Buffer.from(secret, 'hex');
  }

  /** Scope the read to the authenticated account and effective currency, and capture the fill fence before SQL. */
  async read(
    ownerId: string,
    currency: string,
    now: Date,
  ): Promise<WalletSummaryLookup | null> {
    if (!this.synchronized || !this.namespace || !this.connection.canUseCache) {
      return null;
    }
    try {
      const scope = `${ownerId}:${currency}`;
      const result = await this.connection.client.eval(
        readScript,
        3,
        ...this.keys(this.namespace, scope),
        randomUUID(),
        randomUUID(),
      );
      if (
        !Array.isArray(result) ||
        result.length !== 3 ||
        !result.every((value) => typeof value === 'string')
      ) {
        return null;
      }
      const ticket = {
        namespace: this.namespace,
        epoch: result[0] as string,
        generation: result[1] as string,
      };
      return {
        ticket,
        snapshot: this.decode(scope, result[2] as string, now, ticket),
      };
    } catch {
      this.connectionChanged();
      this.connection.reportFailure();
      return null;
    }
  }

  /** Fill only if the pre-SQL generation still matches; expired, evicted, reset or invalidated tickets cannot publish. */
  async write(
    wallet: WalletSummary,
    now: Date,
    ticket: WalletSummaryFillTicket,
  ): Promise<void> {
    const expiresAtMs = now.getTime() + 15_000;
    const ttlMs = expiresAtMs - Date.now();
    if (
      !this.synchronized ||
      !this.connection.canUseCache ||
      this.namespace !== ticket.namespace ||
      ttlMs <= 0
    ) {
      return;
    }
    const scope = `${wallet.ownerId}:${wallet.currency}`;
    const payload = JSON.stringify({
      wallet: {
        ...wallet,
        availableMinorUnits: wallet.availableMinorUnits.toString(),
        reservedMinorUnits: wallet.reservedMinorUnits.toString(),
      },
      epoch: ticket.epoch,
      generation: ticket.generation,
      expiresAtMs,
    });
    try {
      await this.connection.client.eval(
        fillScript,
        3,
        ...this.keys(ticket.namespace, scope),
        ticket.epoch,
        ticket.generation,
        JSON.stringify({ payload, mac: this.mac(scope, payload) }),
        ttlMs,
      );
    } catch {
      this.connectionChanged();
      this.connection.reportFailure();
    }
  }

  /** Rotate fences before acknowledging durable events; failed Redis delivery must retain the outbox version. */
  async invalidate(
    namespace: string,
    scopes: readonly string[],
  ): Promise<void> {
    if (!this.connection.canUseCache) {
      throw new Error('Wallet summary invalidation is unavailable.');
    }
    const prefix = this.prefix(namespace);
    const all = scopes.includes('*');
    const keys = all
      ? [prefix + 'epoch']
      : [
          prefix + 'epoch',
          ...scopes.flatMap((scope) => this.keys(namespace, scope).slice(1)),
        ];
    try {
      await this.connection.client.eval(
        invalidateScript,
        keys.length,
        ...keys,
        all ? 'all' : 'wallets',
        randomUUID(),
      );
    } catch {
      this.connectionChanged();
      this.connection.reportFailure();
      throw new Error('Wallet summary invalidation is unavailable.');
    }
  }

  /** Keep a database/secret namespace in one Redis cluster slot for atomic script execution. */
  private prefix(namespace: string): string {
    return `wallet:summary:v1:{${this.mac('namespace', namespace)}}:`;
  }

  /** Hash account scopes in Redis keys while retaining unambiguous account/currency identity in the MAC. */
  private keys(namespace: string, scope: string): [string, string, string] {
    const prefix = this.prefix(namespace);
    const identity = this.mac('scope', scope);
    return [
      prefix + 'epoch',
      prefix + 'fence:' + identity,
      prefix + 'summary:' + identity,
    ];
  }

  /** Domain-separate wallet display signatures from authentication envelopes and other cached queries. */
  private mac(scope: string, payload: string): string {
    return createHmac('sha256', this.signingKey)
      .update(JSON.stringify(['wallet-summary-cache-v1', scope, payload]))
      .digest('hex');
  }

  /** Corrupt, copied, expired or mismatched-generation payloads become misses without exposing another account's wallet. */
  private decode(
    scope: string,
    encoded: string,
    now: Date,
    ticket: WalletSummaryFillTicket,
  ): WalletSummary | null {
    if (!encoded || encoded.length > 4096) {
      return null;
    }
    try {
      const envelope = decodeRecord(SignedEnvelope, encoded);
      if (
        !envelope ||
        !timingSafeEqual(
          Buffer.from(this.mac(scope, envelope.payload), 'hex'),
          Buffer.from(envelope.mac, 'hex'),
        )
      ) {
        return null;
      }
      const snapshot = decodeRecord(StoredSnapshot, envelope.payload);
      if (
        !snapshot ||
        snapshot.epoch !== ticket.epoch ||
        snapshot.generation !== ticket.generation ||
        snapshot.expiresAtMs <= now.getTime()
      ) {
        return null;
      }
      const wallet = snapshot.wallet;
      if (`${wallet.ownerId}:${wallet.currency}` !== scope) {
        return null;
      }
      return {
        ...wallet,
        availableMinorUnits: BigInt(wallet.availableMinorUnits),
        reservedMinorUnits: BigInt(wallet.reservedMinorUnits),
      };
    } catch {
      return null;
    }
  }
}
