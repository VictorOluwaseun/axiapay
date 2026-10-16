import { airtimeInstruction } from './airtime-processor-fixture.js';
import type { ServicePayment } from '../../src/modules/payments/domain/payment.js';
import type { ServiceProduct } from '../../src/modules/service-catalog/domain/service-product.js';
import { vtpassRequestId } from '../../src/modules/payments/adapters/vtpass-airtime.protocol.js';

/** Test-only configured route; not a provider credential or an installed database account. */
export const vtpassTestAccountId = '8f819840-74b1-4822-a55b-f4fbaf1f2c90';

/** Construct compatible first-party airtime terms without spending or invoking a provider. */
export function vtpassInstruction(): ServicePayment {
  const payment = airtimeInstruction(`vtpass:sandbox:${vtpassTestAccountId}`);
  return {
    ...payment,
    quote: {
      ...payment.quote,
      networkCode: 'mtn',
      providerProductCode: 'mtn',
      recipientPhoneNumber: '+2348011111111',
    },
  };
}

/** Supply complete catalogue terms for pure capability checks, retaining the instruction's provider route. */
export function vtpassProduct(payment = vtpassInstruction()): ServiceProduct {
  return {
    ...payment.quote,
    id: payment.quote.productId,
    currency: payment.quote.principal.currency,
    bankId: null,
    bankBeneficiaryValidationLifetimeSeconds: null,
    accountValidationLifetimeSeconds: null,
    educationValidationLifetimeSeconds: null,
    insuranceApplicationLifetimeSeconds: null,
    fixedPriceMinorUnits: null,
    minimumAmountMinorUnits: 100n,
    maximumAmountMinorUnits: 100_000n,
    amountStepMinorUnits: 1n,
    quoteLifetimeSeconds: 300,
    isEnabled: true,
  };
}

/** Model the documented authenticated response subset. Merchant phone intentionally differs from the true recipient in unique_element. */
export function vtpassDelivered(
  payment: ServicePayment,
): Record<string, unknown> {
  return {
    code: '000',
    requestId: vtpassRequestId(payment),
    amount: '100.00',
    content: {
      transactions: {
        status: 'delivered',
        product_name: 'MTN Airtime VTU',
        unique_element: '08011111111',
        phone: '123450987623',
        unit_price: '100.00',
        quantity: '1',
        amount: '100.00',
        type: 'Airtime Recharge',
        transactionId: '17415980564672211596777904',
      },
    },
  };
}
