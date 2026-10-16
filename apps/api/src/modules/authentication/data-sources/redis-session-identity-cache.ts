import { RecoverableRedisCache } from '../../../infrastructure/redis/recoverable-redis-cache.js';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { RedisCacheConnection } from '../../../infrastructure/redis/redis-cache-connection.js';
import type {
  CachedSessionIdentity,
  SessionCacheFillTicket,
  SessionCacheLookup,
  SessionIdentityCache,
} from '../repositories/contracts/session-identity-cache.js';

import {
  readScript,
  fillScript,
  invalidateScript,
} from '../../../infrastructure/redis/generation-cache-scripts.js';

const snapshotSchema = z
  .object({
    identity: z
      .object({
        id: z.uuid(),
        contact: z
          .object({
            kind: z.enum(['email', 'phone']),
            value: z.string().min(1).max(254),
          })
          .strict(),
        verifiedAt: z.iso.datetime(),
      })
      .strict(),
    expiresAtMs: z.number().int().positive(),
    cacheExpiresAtMs: z.number().int().positive(),
    epoch: z.uuid(),
    generation: z.uuid(),
  })
  .strict();
const envelopeSchema = z
  .object({
    payload: z.string().max(2_048),
    mac: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

/** Cache signed public identities with Redis-only hits and atomic generation-fenced fills/invalidation. */
export class RedisSessionIdentityCache
  extends RecoverableRedisCache
  implements SessionIdentityCache
{
  private readonly signingKey: Buffer;
  /** Bind signed authentication payloads to a shared managed cache connection. */
  constructor(connection: RedisCacheConnection, secret: string) {
    super(connection);
    this.signingKey = Buffer.from(secret, 'hex');
  }

  /** Read/fence atomically in Redis; check payload signature, generation and absolute expiry locally. */
  async read(
    tokenDigest: string,
    now: Date,
  ): Promise<SessionCacheLookup | null> {
    if (!this.synchronized || !this.namespace || !this.connection.canUseCache) {
      return null;
    }
    try {
      const result = await this.connection.client.eval(
        readScript,
        3,
        ...this.keys(this.namespace, tokenDigest),
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
        snapshot: this.decode(tokenDigest, result[2] as string, now, ticket),
      };
    } catch {
      this.connectionChanged();
      this.connection.reportFailure();
      return null;
    }
  }

  /** Cache at most 60 seconds within session expiry, and reject fills when invalidation changes the original generation. */
  async write(
    tokenDigest: string,
    snapshot: CachedSessionIdentity,
    now: Date,
    ticket: SessionCacheFillTicket,
  ): Promise<void> {
    const ttlMs = Math.min(60_000, snapshot.expiresAtMs - now.getTime());
    if (
      !this.synchronized ||
      !this.connection.canUseCache ||
      this.namespace !== ticket.namespace ||
      ttlMs <= 0
    ) {
      return;
    }
    const payload = JSON.stringify({
      ...snapshot,
      cacheExpiresAtMs: now.getTime() + ttlMs,
      epoch: ticket.epoch,
      generation: ticket.generation,
    });
    try {
      await this.connection.client.eval(
        fillScript,
        3,
        ...this.keys(ticket.namespace, tokenDigest),
        ticket.epoch,
        ticket.generation,
        JSON.stringify({ payload, mac: this.mac(tokenDigest, payload) }),
        ttlMs,
      );
    } catch {
      this.connectionChanged();
      this.connection.reportFailure();
    }
  }

  /** Delete affected payloads and rotate fences after commit; failures throw so durable work is not acknowledged. */
  async invalidate(
    namespace: string,
    tokenDigests: readonly string[],
  ): Promise<void> {
    if (!this.connection.canUseCache) {
      throw new Error('Session cache invalidation is unavailable.');
    }
    const prefix = this.prefix(namespace);
    const all = tokenDigests.includes('*');
    const keys = all
      ? [prefix + 'epoch']
      : [
          prefix + 'epoch',
          ...tokenDigests.flatMap((digest) => [
            prefix + 'fence:' + digest,
            prefix + 'identity:' + digest,
          ]),
        ];
    try {
      await this.connection.client.eval(
        invalidateScript,
        keys.length,
        ...keys,
        all ? 'all' : 'sessions',
        randomUUID(),
      );
    } catch {
      this.connectionChanged();
      this.connection.reportFailure();
      throw new Error('Session cache invalidation is unavailable.');
    }
  }

  /** Keep atomic script keys in one Redis cluster slot while separating database namespaces and auth secrets. */
  private prefix(namespace: string): string {
    return `auth:session:v2:{${this.mac('namespace', namespace)}}:`;
  }

  /** Select the epoch, session fence and scoped identity for one token digest. */
  private keys(namespace: string, digest: string): [string, string, string] {
    const prefix = this.prefix(namespace);
    return [
      prefix + 'epoch',
      prefix + 'fence:' + digest,
      prefix + 'identity:' + digest,
    ];
  }

  /** Bind signatures to the serialized identity and digest, excluding bearer credentials. */
  private mac(scope: string, payload: string): string {
    return createHmac('sha256', this.signingKey)
      .update(JSON.stringify(['session-identity-cache-v2', scope, payload]))
      .digest('hex');
  }

  /** Project signed public identity under the observed generation; corrupt, expired or copied records are misses. */
  private decode(
    tokenDigest: string,
    encoded: string,
    now: Date,
    ticket: SessionCacheFillTicket,
  ): CachedSessionIdentity | null {
    if (!encoded || encoded.length > 4_096) {
      return null;
    }
    try {
      const envelope = envelopeSchema.safeParse(JSON.parse(encoded));
      if (!envelope.success) {
        return null;
      }
      const expected = Buffer.from(
        this.mac(tokenDigest, envelope.data.payload),
        'hex',
      );
      if (!timingSafeEqual(expected, Buffer.from(envelope.data.mac, 'hex'))) {
        return null;
      }
      const snapshot = snapshotSchema.safeParse(
        JSON.parse(envelope.data.payload),
      );
      if (!snapshot.success) {
        return null;
      }
      if (
        snapshot.data.epoch !== ticket.epoch ||
        snapshot.data.generation !== ticket.generation
      ) {
        return null;
      }
      if (
        Math.min(snapshot.data.expiresAtMs, snapshot.data.cacheExpiresAtMs) <=
        now.getTime()
      ) {
        return null;
      }
      return {
        identity: snapshot.data.identity,
        expiresAtMs: snapshot.data.expiresAtMs,
      };
    } catch {
      return null;
    }
  }
}
