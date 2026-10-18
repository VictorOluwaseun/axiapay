import { sql, type Kysely, type Selectable } from 'kysely';
import type { DatabaseSchema } from '@axiapay/payments-runtime/infrastructure/database/create-database';
import type { AirtimeConversionQuotes } from '@axiapay/payments-runtime/infrastructure/database/database.generated';
import { fundingFingerprint } from '@axiapay/payments-runtime/modules/wallets/domain/funding-identity';
import {
  ConversionError,
  conversionFingerprint,
  type ConversionExceptionCode,
  type ConversionQuote,
  type ConversionRequest,
} from '../domain/conversion.js';
import type { ConversionRepository } from './contracts/conversion.repository.js';

/** PostgreSQL append-only snapshots and proof; transaction locks serialize acceptance, while all external I/O stays in services. No cache. */
export class PostgresConversionRepository implements ConversionRepository {
  /** Borrow the lifecycle-managed pool; never create connections per operation. */
  constructor(private readonly database: Kysely<DatabaseSchema>) {}

  /** @inheritdoc ConversionRepository.saveQuote */
  async saveQuote(quote: ConversionQuote): Promise<void> {
    const offer = quote.offer;
    await this.database
      .insertInto('airtime_conversion_quotes')
      .values({
        id: quote.id,
        owner_id: quote.ownerId,
        wallet_id: quote.walletId,
        source_phone_number: quote.sourcePhoneNumber,
        offer_id: offer.id,
        display_name: offer.displayName,
        network_code: offer.networkCode,
        currency: offer.currency,
        terms_version: offer.termsVersion,
        rate_numerator: offer.rateNumerator,
        rate_denominator: offer.rateDenominator,
        fixed_fee_minor_units: offer.fixedFeeMinorUnits,
        fee_basis_points: offer.feeBasisPoints,
        minimum_airtime_minor_units: offer.minimumAirtimeMinorUnits,
        maximum_airtime_minor_units: offer.maximumAirtimeMinorUnits,
        airtime_step_minor_units: offer.airtimeStepMinorUnits,
        quote_validity_seconds: offer.quoteValiditySeconds,
        transfer_window_seconds: offer.transferWindowSeconds,
        airtime_minor_units: quote.airtimeValue.amountMinorUnits,
        gross_credit_minor_units: quote.grossCreditValue.amountMinorUnits,
        fee_minor_units: quote.feeMinorUnits,
        net_credit_minor_units: quote.netCreditValue.amountMinorUnits,
        provider_id: quote.providerId,
        partner_account_id: quote.partnerAccountId,
        provider_product_code: quote.providerProductCode,
        eligibility_reference: quote.eligibilityReference,
        quoted_at: quote.quotedAt,
        expires_at: quote.expiresAt,
      })
      .execute();
  }

  /** @inheritdoc ConversionRepository.getQuote */
  async getQuote(id: string): Promise<ConversionQuote | null> {
    const record = await this.database
      .selectFrom('airtime_conversion_quotes')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return record ? mapQuote(record) : null;
  }

  /** @inheritdoc ConversionRepository.acceptQuote */
  async acceptQuote(
    input: Parameters<ConversionRepository['acceptQuote']>[0],
    authorize: Parameters<ConversionRepository['acceptQuote']>[1],
  ): Promise<ConversionRequest> {
    const conversionId = await this.database
      .transaction()
      .execute(async (transaction) => {
        // Serialize even different quotes sharing an owner/key; hash collisions only cause harmless extra serialization.
        await sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([input.ownerId, input.requestKey])}, 0))`.execute(
          transaction,
        );
        const existing = await transaction
          .selectFrom('airtime_conversions')
          .select(['id', 'quote_id'])
          .where('owner_id', '=', input.ownerId)
          .where('request_key', '=', input.requestKey)
          .executeTakeFirst();
        if (existing?.quote_id === input.quoteId) {
          return existing.id;
        }
        if (existing) {
          throw new ConversionError('CONVERSION_CONFLICT');
        }
        const quoteRecord = await transaction
          .selectFrom('airtime_conversion_quotes')
          .selectAll()
          .where('id', '=', input.quoteId)
          .where('owner_id', '=', input.ownerId)
          .forUpdate()
          .executeTakeFirst();
        if (!quoteRecord) {
          throw new ConversionError('CONVERSION_NOT_FOUND');
        }
        const consumed = await transaction
          .selectFrom('airtime_conversions')
          .select('id')
          .where('quote_id', '=', input.quoteId)
          .executeTakeFirst();
        if (consumed) {
          throw new ConversionError('CONVERSION_CONFLICT');
        }
        const quote = mapQuote(quoteRecord);
        const acceptance = await authorize(quote);
        const request: ConversionRequest = {
          id: input.id,
          quote,
          requestKey: input.requestKey,
          ...acceptance,
          initializationStartedAt: null,
          instructions: null,
          outcome: null,
          operationId: null,
          hasPostingConflict: false,
        };
        await transaction
          .insertInto('airtime_conversions')
          .values({
            id: request.id,
            owner_id: input.ownerId,
            quote_id: input.quoteId,
            request_key: input.requestKey,
            request_fingerprint: conversionFingerprint(request),
            accepted_at: request.acceptedAt,
            receive_by: request.receiveBy,
          })
          .execute();
        return request.id;
      });
    return this.require(conversionId);
  }

  /** @inheritdoc ConversionRepository.get */
  async get(id: string): Promise<ConversionRequest | null> {
    const record = await this.database
      .selectFrom('airtime_conversions as request')
      .leftJoin(
        'airtime_conversion_instructions as instructions',
        'instructions.conversion_id',
        'request.id',
      )
      .leftJoin(
        'airtime_conversion_outcomes as outcome',
        'outcome.conversion_id',
        'request.id',
      )
      .leftJoin('wallet_operations as operation', (join) =>
        join
          .onRef('operation.request_key', '=', 'outcome.external_movement_id')
          .on(
            'operation.request_scope',
            '=',
            sql<string>`'funding:' || outcome.partner_account_id::text`,
          )
          .on('outcome.outcome', '=', 'verified'),
      )
      .leftJoin('ledger_journals as journal', 'journal.id', 'operation.id')
      .selectAll('request')
      .select([
        'instructions.instruction_reference',
        'instructions.receiving_phone_number',
        'instructions.description',
        'instructions.issued_at',
        'outcome.outcome',
        'outcome.exception_code',
        'outcome.external_movement_id',
        'outcome.evidence_reference',
        'outcome.received_at',
        'outcome.observed_airtime_minor_units',
        'outcome.observed_currency',
        'outcome.receipt_fingerprint',
        'journal.id as operation_id',
        'journal.evidence_reference as journal_evidence',
        'operation.request_fingerprint as posting_fingerprint',
      ])
      .where('request.id', '=', id)
      .executeTakeFirst();
    if (!record) {
      return null;
    }
    const quote = await this.getQuote(record.quote_id);
    if (!quote) {
      throw new ConversionError('CONVERSION_NOT_FOUND');
    }
    return {
      id: record.id,
      quote,
      requestKey: record.request_key,
      acceptedAt: record.accepted_at,
      receiveBy: record.receive_by,
      initializationStartedAt: record.initialization_started_at,
      instructions: record.instruction_reference
        ? {
            instructionReference: record.instruction_reference,
            receivingPhoneNumber: record.receiving_phone_number!,
            description: record.description!,
            issuedAt: record.issued_at!,
          }
        : null,
      outcome: record.outcome
        ? {
            outcome: record.outcome as 'verified' | 'exception',
            exceptionCode:
              record.exception_code as ConversionExceptionCode | null,
            externalMovementId: record.external_movement_id,
            evidenceReference: record.evidence_reference!,
            receivedAt: record.received_at,
            observedAirtimeValue:
              record.observed_airtime_minor_units !== null &&
              record.observed_currency
                ? {
                    amountMinorUnits: BigInt(
                      record.observed_airtime_minor_units,
                    ),
                    currency: record.observed_currency,
                  }
                : null,
            receiptFingerprint: record.receipt_fingerprint!,
          }
        : null,
      // Never attribute another feature's journal, or conflicting net terms, to this conversion.
      operationId:
        record.posting_fingerprint ===
          fundingFingerprint(quote.walletId, quote.netCreditValue) &&
        record.journal_evidence === `airtime-conversion:${record.id}`
          ? record.operation_id
          : null,
      hasPostingConflict:
        record.operation_id !== null &&
        (record.posting_fingerprint !==
          fundingFingerprint(quote.walletId, quote.netCreditValue) ||
          record.journal_evidence !== `airtime-conversion:${record.id}`),
    };
  }

  /** @inheritdoc ConversionRepository.findByRequestKey */
  async findByRequestKey(
    ownerId: string,
    requestKey: string,
  ): Promise<ConversionRequest | null> {
    const record = await this.database
      .selectFrom('airtime_conversions')
      .select('id')
      .where('owner_id', '=', ownerId)
      .where('request_key', '=', requestKey)
      .executeTakeFirst();
    return record ? this.get(record.id) : null;
  }

  /** @inheritdoc ConversionRepository.claimPreparation */
  async claimPreparation(id: string): Promise<boolean> {
    const record = await this.database
      .updateTable('airtime_conversions')
      .set({ initialization_started_at: sql<Date>`now()` })
      .where('id', '=', id)
      .where('initialization_started_at', 'is', null)
      .returning('id')
      .executeTakeFirst();
    return record !== undefined;
  }

  /** @inheritdoc ConversionRepository.saveInstructions */
  async saveInstructions(
    id: string,
    instructions: Parameters<ConversionRepository['saveInstructions']>[1],
  ): Promise<void> {
    const fingerprint = JSON.stringify([
      instructions.instructionReference,
      instructions.receivingPhoneNumber,
      instructions.description,
      instructions.issuedAt.toISOString(),
    ]);
    await this.database
      .insertInto('airtime_conversion_instructions')
      .values({
        conversion_id: id,
        instruction_reference: instructions.instructionReference,
        receiving_phone_number: instructions.receivingPhoneNumber,
        description: instructions.description,
        issued_at: instructions.issuedAt,
        instructions_fingerprint: fingerprint,
      })
      .onConflict((conflict) => conflict.column('conversion_id').doNothing())
      .execute();
    const record = await this.database
      .selectFrom('airtime_conversion_instructions')
      .select('instructions_fingerprint')
      .where('conversion_id', '=', id)
      .executeTakeFirstOrThrow();
    if (record.instructions_fingerprint !== fingerprint) {
      throw new ConversionError('CONVERSION_CONFLICT');
    }
  }

  /** @inheritdoc ConversionRepository.saveOutcome */
  async saveOutcome(
    id: string,
    partnerAccountId: string,
    outcome: Parameters<ConversionRepository['saveOutcome']>[2],
  ): Promise<'saved' | 'movement_conflict'> {
    await this.database
      .insertInto('airtime_conversion_outcomes')
      .values({
        conversion_id: id,
        partner_account_id: partnerAccountId,
        outcome: outcome.outcome,
        exception_code: outcome.exceptionCode,
        external_movement_id: outcome.externalMovementId,
        evidence_reference: outcome.evidenceReference,
        received_at: outcome.receivedAt,
        observed_airtime_minor_units:
          outcome.observedAirtimeValue?.amountMinorUnits ?? null,
        observed_currency: outcome.observedAirtimeValue?.currency ?? null,
        receipt_fingerprint: outcome.receiptFingerprint,
        receipt: JSON.parse(outcome.receiptFingerprint),
      })
      .onConflict((conflict) => conflict.doNothing())
      .execute();
    const record = await this.database
      .selectFrom('airtime_conversion_outcomes')
      .select(['receipt_fingerprint', 'outcome', 'exception_code'])
      .where('conversion_id', '=', id)
      .executeTakeFirst();
    if (!record) {
      return 'movement_conflict';
    }
    if (
      record.receipt_fingerprint !== outcome.receiptFingerprint ||
      record.outcome !== outcome.outcome ||
      record.exception_code !== outcome.exceptionCode
    ) {
      throw new ConversionError('CONVERSION_CONFLICT');
    }
    return 'saved';
  }

  /** Read committed progress after an insert/claim without manufacturing a missing record. */
  private async require(id: string): Promise<ConversionRequest> {
    const request = await this.get(id);
    if (!request) {
      throw new ConversionError('CONVERSION_NOT_FOUND');
    }
    return request;
  }
}

/** Convert SQL bigint representations to exact domain values; persistence column names stay inside this repository. */
function mapQuote(
  record: Selectable<AirtimeConversionQuotes>,
): ConversionQuote {
  return {
    id: record.id,
    ownerId: record.owner_id,
    walletId: record.wallet_id,
    sourcePhoneNumber: record.source_phone_number,
    offer: {
      id: record.offer_id,
      displayName: record.display_name,
      networkCode: record.network_code,
      currency: record.currency,
      termsVersion: record.terms_version,
      rateNumerator: BigInt(record.rate_numerator),
      rateDenominator: BigInt(record.rate_denominator),
      fixedFeeMinorUnits: BigInt(record.fixed_fee_minor_units),
      feeBasisPoints: record.fee_basis_points,
      minimumAirtimeMinorUnits: BigInt(record.minimum_airtime_minor_units),
      maximumAirtimeMinorUnits: BigInt(record.maximum_airtime_minor_units),
      airtimeStepMinorUnits: BigInt(record.airtime_step_minor_units),
      quoteValiditySeconds: record.quote_validity_seconds,
      transferWindowSeconds: record.transfer_window_seconds,
    },
    airtimeValue: {
      amountMinorUnits: BigInt(record.airtime_minor_units),
      currency: record.currency,
    },
    grossCreditValue: {
      amountMinorUnits: BigInt(record.gross_credit_minor_units),
      currency: record.currency,
    },
    feeMinorUnits: BigInt(record.fee_minor_units),
    netCreditValue: {
      amountMinorUnits: BigInt(record.net_credit_minor_units),
      currency: record.currency,
    },
    providerId: record.provider_id,
    partnerAccountId: record.partner_account_id,
    providerProductCode: record.provider_product_code,
    eligibilityReference: record.eligibility_reference,
    quotedAt: record.quoted_at,
    expiresAt: record.expires_at,
  };
}
