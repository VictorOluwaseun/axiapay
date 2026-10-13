import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../../../infrastructure/database/create-database.js';
import type { FundingRepository } from './contracts/funding.repository.js';
import { FundingError, type FundingRequest } from '../domain/funding.js';
import { fundingFingerprint } from '../../wallets/domain/funding-identity.js';

/** PostgreSQL funding storage; database uniqueness serializes claims and movement binding, with no financial cache. */
export class PostgresFundingRepository implements FundingRepository {
  /** Borrow the shared pool; initialization and partner verification happen outside database transactions. */
  constructor(private readonly database: Kysely<DatabaseSchema>) {}

  /** @inheritdoc FundingRepository.create */
  async create(
    request: Parameters<FundingRepository['create']>[0],
  ): Promise<FundingRequest> {
    await this.database
      .insertInto('wallet_funding_requests')
      .values({
        id: request.id,
        owner_id: request.ownerId,
        wallet_id: request.walletId,
        currency: request.value.currency,
        amount_minor_units: request.value.amountMinorUnits,
        partner: request.adapterId,
        environment: request.environment,
        partner_account_id: request.partnerAccountId,
        payer_email: request.payerEmail,
        funding_option_id: request.fundingOptionId,
        request_key: request.requestKey,
        request_fingerprint: request.requestFingerprint,
      })
      .onConflict((conflict) =>
        conflict.columns(['owner_id', 'request_key']).doNothing(),
      )
      .execute();
    const existing = await this.database
      .selectFrom('wallet_funding_requests')
      .select(['id', 'request_fingerprint'])
      .where('owner_id', '=', request.ownerId)
      .where('request_key', '=', request.requestKey)
      .executeTakeFirstOrThrow();
    if (existing.request_fingerprint !== request.requestFingerprint) {
      throw new FundingError('FUNDING_CONFLICT');
    }
    const saved = await this.get(existing.id);
    if (!saved) {
      throw new FundingError('FUNDING_NOT_FOUND');
    }
    return saved;
  }

  /** @inheritdoc FundingRepository.get */
  async get(id: string): Promise<FundingRequest | null> {
    const record = await this.database
      .selectFrom('wallet_funding_requests as request')
      .leftJoin(
        'wallet_funding_payments as payment',
        'payment.funding_request_id',
        'request.id',
      )
      .leftJoin('wallet_operations as operation', (join) =>
        join
          .onRef('operation.request_key', '=', 'payment.external_movement_id')
          .on(
            'operation.request_scope',
            '=',
            sql<string>`'funding:' || request.partner_account_id::text`,
          ),
      )
      .leftJoin('ledger_journals as journal', 'journal.id', 'operation.id')
      .selectAll('request')
      .select([
        'payment.external_movement_id',
        'journal.id as operation_id',
        'operation.request_fingerprint as posting_fingerprint',
      ])
      .where('request.id', '=', id)
      .executeTakeFirst();
    if (!record) {
      return null;
    }
    return {
      id: record.id,
      ownerId: record.owner_id,
      walletId: record.wallet_id,
      value: {
        amountMinorUnits: BigInt(record.amount_minor_units),
        currency: record.currency,
      },
      adapterId: record.partner,
      fundingOptionId: record.funding_option_id,
      environment: record.environment as FundingRequest['environment'],
      partnerAccountId: record.partner_account_id,
      payerEmail: record.payer_email,
      requestKey: record.request_key,
      requestFingerprint: record.request_fingerprint,
      initializationStartedAt: record.initialization_started_at,
      checkoutUrl: record.checkout_url,
      externalMovementId: record.external_movement_id,
      // An older integration may already have claimed this movement with different terms; never report that credit as ours.
      operationId:
        record.posting_fingerprint ===
        fundingFingerprint(record.wallet_id, {
          currency: record.currency,
          amountMinorUnits: BigInt(record.amount_minor_units),
        })
          ? record.operation_id
          : null,
    };
  }

  /** @inheritdoc FundingRepository.findByRequestKey */
  async findByRequestKey(
    ownerId: string,
    requestKey: string,
  ): Promise<FundingRequest | null> {
    const record = await this.database
      .selectFrom('wallet_funding_requests')
      .select('id')
      .where('owner_id', '=', ownerId)
      .where('request_key', '=', requestKey)
      .executeTakeFirst();
    return record ? this.get(record.id) : null;
  }

  /** @inheritdoc FundingRepository.claimInitialization */
  async claimInitialization(id: string): Promise<boolean> {
    const result = await this.database
      .updateTable('wallet_funding_requests')
      .set({ initialization_started_at: sql<Date>`now()` })
      .where('id', '=', id)
      .where('initialization_started_at', 'is', null)
      .returning('id')
      .executeTakeFirst();
    return result !== undefined;
  }

  /** @inheritdoc FundingRepository.saveCheckout */
  async saveCheckout(id: string, checkoutUrl: string): Promise<void> {
    await this.database
      .updateTable('wallet_funding_requests')
      .set({ checkout_url: checkoutUrl })
      .where('id', '=', id)
      .where('checkout_url', 'is', null)
      .executeTakeFirstOrThrow();
  }

  /** @inheritdoc FundingRepository.recordVerifiedPayment */
  async recordVerifiedPayment(
    request: FundingRequest,
    externalMovementId: string,
  ): Promise<void> {
    await this.database
      .insertInto('wallet_funding_payments')
      .values({
        funding_request_id: request.id,
        partner: request.adapterId,
        environment: request.environment,
        external_movement_id: externalMovementId,
      })
      .onConflict((conflict) => conflict.doNothing())
      .execute();
    const payment = await this.database
      .selectFrom('wallet_funding_payments')
      .select('external_movement_id')
      .where('funding_request_id', '=', request.id)
      .executeTakeFirst();
    if (payment?.external_movement_id !== externalMovementId) {
      throw new FundingError('FUNDING_CONFLICT');
    }
  }
}
