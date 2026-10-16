import { Inject, Injectable } from '@nestjs/common';
import { WalletService } from '../../wallets/services/wallet.service.js';
import type { PaymentQuote, ServicePayment } from '../domain/payment.js';
import { paymentStatus } from '../domain/payment.js';
import { PaymentExecutionService } from './payment-execution.service.js';
import { PaymentQuoteService } from './payment-quote.service.js';
import { needsPaymentFulfilment } from '../domain/payment-fulfilment.js';

/** Coordinate first-party quote review, owner-authorized holds, external execution, and journal settlement with crash-safe identities. */
@Injectable()
export class WalletPaymentService {
  /** Services expose workflows; repositories, SQL connections and concrete adapters stay within their feature modules. */
  constructor(
    @Inject(WalletService) private readonly wallets: WalletService,
    @Inject(PaymentQuoteService) private readonly quotes: PaymentQuoteService,
    @Inject(PaymentExecutionService)
    private readonly execution: PaymentExecutionService,
  ) {}

  /** Read the actual owned wallet before pricing; a quote does not reserve or debit money. */
  async createQuote(input: {
    readonly actorId: string;
    readonly walletId: string;
    readonly productId: string;
    readonly recipientPhoneNumber?: string;
    readonly accountValidationId?: string;
    readonly bankBeneficiaryValidationId?: string;
    readonly narration?: string;
    readonly educationValidationId?: string;
    readonly insuranceApplicationId?: string;
    readonly amountMinorUnits?: bigint;
  }): Promise<PaymentQuote> {
    const wallet = await this.wallets.getWalletBalance({
      actorId: input.actorId,
      walletId: input.walletId,
    });
    return this.quotes.create({ ...input, wallet });
  }

  /** Submit explicit consent for immutable quoted terms; replay returns/resumes the same logical payment across every transport. */
  async submit(input: {
    readonly actorId: string;
    readonly quoteId: string;
    readonly requestKey: string;
  }): Promise<ServicePayment> {
    const quote = await this.quotes.get(input.actorId, input.quoteId);
    await this.wallets.getWalletBalance({
      actorId: input.actorId,
      walletId: quote.walletId,
    });
    const payment = await this.execution.accept(input);
    if (['succeeded', 'failed'].includes(paymentStatus(payment))) {
      return payment;
    }
    if (payment.outcome) {
      return this.settleIfConfirmed(payment);
    }
    await this.execution.prepareReservation(payment);
    // A durable payment record precedes the hold. Repeating this derived key recovers a crash between the two commits.
    await this.wallets.reserveWalletFunds({
      actorId: input.actorId,
      walletId: quote.walletId,
      requestKey: `payment:${payment.id}`,
      paymentReference: payment.id,
      validateAuthorization: () => this.quotes.assertCurrent(quote),
      value: {
        currency: quote.principal.currency,
        amountMinorUnits: quote.totalDebitMinorUnits,
      },
    });
    const reserved = await this.execution.get(input.actorId, payment.id);
    return this.settleIfConfirmed(await this.execution.dispatch(reserved));
  }

  /** Read owner-scoped durable progress without spending, dispatching, or requiring an adapter to remain configured. */
  get(actorId: string, paymentId: string): Promise<ServicePayment> {
    return this.execution.get(actorId, paymentId);
  }

  /** Query a caller's original logical identity without requiring a payment ID or a currently configured adapter. */
  findByRequestKey(
    actorId: string,
    requestKey: string,
  ): Promise<ServicePayment> {
    return this.execution.findByRequestKey(actorId, requestKey);
  }

  /** Settle stored final evidence before optional bill-receipt lookup; recover an existing hold without buying or reserving again. */
  async reconcile(actorId: string, paymentId: string): Promise<ServicePayment> {
    const observed = await this.execution.get(actorId, paymentId);
    const payment = observed.outcome
      ? await this.settleIfConfirmed(observed)
      : observed;
    if (
      ['succeeded', 'failed'].includes(paymentStatus(payment)) &&
      !needsPaymentFulfilment(payment)
    ) {
      return payment;
    }
    return this.settleIfConfirmed(await this.execution.reconcile(payment));
  }

  /** Capture/release only correlated final evidence; a crash after evidence storage is safely recoverable without another provider call. */
  private async settleIfConfirmed(
    payment: ServicePayment,
  ): Promise<ServicePayment> {
    if (!payment.outcome || !payment.reservationId) {
      return payment;
    }
    await this.wallets.settleWalletReservation({
      reservationId: payment.reservationId,
      evidenceReference: payment.id,
    });
    return this.execution.get(payment.ownerId, payment.id);
  }
}
