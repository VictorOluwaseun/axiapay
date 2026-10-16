import { Catch } from '@nestjs/common';
import { HttpExceptionFilter } from '../../../shared/http/http-exception.filter.js';
import type { HttpFailure } from '../../../shared/http/http-failure.js';
import { AuthenticationError } from '../../authentication/domain/authentication-error.js';
import { WalletError } from '@axiapay/backend/modules/wallets/domain/wallet-error';
import { PaymentError } from '@axiapay/backend/modules/payments/domain/payment';
import { paymentErrorDescription } from '@axiapay/backend/modules/payments/domain/payment-error-reasons';

/** Public error mapping hides storage/provider diagnostics and inaccessible wallet/quote/payment identities. */
const paymentFailures: Record<
  PaymentError['code'],
  { status: number; message: string }
> = {
  BANK_UNAVAILABLE: { status: 404, message: 'Bank unavailable.' },
  BANK_BENEFICIARY_NOT_FOUND: {
    status: 404,
    message: 'Bank beneficiary validation not found.',
  },
  BANK_BENEFICIARY_EXPIRED: {
    status: 409,
    message:
      'Verify the receiving account before reviewing a new transfer quote.',
  },
  BANK_BENEFICIARY_INVALID: {
    status: 400,
    message: 'The receiving bank account is invalid.',
  },
  BANK_BENEFICIARY_UNCONFIRMED: {
    status: 503,
    message: 'Receiving account verification remains unconfirmed.',
  },
  BANK_TRANSFER_NOT_FOUND: { status: 404, message: 'Bank transfer not found.' },
  EDUCATION_BENEFICIARY_INVALID: {
    status: 400,
    message: 'The selected education beneficiary is invalid.',
  },
  EDUCATION_BENEFICIARY_UNCONFIRMED: {
    status: 503,
    message: 'Education beneficiary verification remains unconfirmed.',
  },
  EDUCATION_VALIDATION_NOT_FOUND: {
    status: 404,
    message: 'Education beneficiary validation not found.',
  },
  EDUCATION_VALIDATION_EXPIRED: {
    status: 409,
    message: 'Verify the beneficiary before reviewing a fresh quote.',
  },
  INSURANCE_APPLICATION_NOT_FOUND: {
    status: 404,
    message: 'Insurance application not found.',
  },
  INSURANCE_APPLICATION_EXPIRED: {
    status: 409,
    message: 'Review terms and confirm eligibility again.',
  },
  INSURANCE_TERMS_CHANGED: {
    status: 409,
    message: 'Review and accept the selected insurance terms.',
  },
  INSURANCE_INELIGIBLE: {
    status: 400,
    message: 'Application is ineligible for this product.',
  },
  INSURANCE_UNCONFIRMED: {
    status: 503,
    message: 'Insurance eligibility remains unconfirmed.',
  },
  DOCUMENT_NOT_FOUND: { status: 404, message: 'Document not found.' },
  DOCUMENT_UNAVAILABLE: {
    status: 503,
    message: 'Document retrieval is temporarily unavailable.',
  },
  INVALID_PAYMENT: { status: 400, message: 'Invalid payment terms.' },
  ACCOUNT_VALIDATION_NOT_FOUND: {
    status: 404,
    message: 'Account validation not found.',
  },
  ACCOUNT_VALIDATION_EXPIRED: {
    status: 409,
    message:
      'Account validation expired. Verify the recipient before reviewing a new quote.',
  },
  ACCOUNT_INVALID: {
    status: 400,
    message: 'The selected bill account is invalid.',
  },
  ACCOUNT_UNCONFIRMED: {
    status: 503,
    message: 'Bill account verification remains unconfirmed.',
  },
  PRODUCT_UNAVAILABLE: { status: 404, message: 'Product unavailable.' },
  QUOTE_NOT_FOUND: { status: 404, message: 'Quote not found.' },
  QUOTE_EXPIRED: {
    status: 409,
    message: 'Quote expired. Review a fresh quote before submitting.',
  },
  PAYMENT_NOT_FOUND: { status: 404, message: 'Payment not found.' },
  PAYMENT_CONFLICT: {
    status: 409,
    message: 'Request key or quote already bound to another payment.',
  },
  PAYMENT_UNAVAILABLE: {
    status: 503,
    message:
      'Payment unavailable or outcome uncertain. Keep the same request key and check existing progress.',
  },
  INVALID_PROVIDER_EVIDENCE: {
    status: 503,
    message: 'Payment outcome requires reconciliation.',
  },
};

/** Map financial authorization failures without reporting an uncertain operation as a confirmed failed purchase. */
function walletFailure(
  error: WalletError,
): { status: number; code: string; message: string } | null {
  if (['FORBIDDEN', 'WALLET_NOT_FOUND'].includes(error.code)) {
    return {
      status: 404,
      code: 'WALLET_NOT_FOUND',
      message: 'Wallet not found.',
    };
  }
  if (
    ['INVALID_AMOUNT', 'INVALID_CURRENCY', 'INVALID_REFERENCE'].includes(
      error.code,
    )
  ) {
    return { status: 400, code: error.code, message: 'Invalid payment terms.' };
  }
  if (
    [
      'INSUFFICIENT_FUNDS',
      'WALLET_RESTRICTED',
      'CURRENCY_MISMATCH',
      'IDEMPOTENCY_CONFLICT',
    ].includes(error.code)
  ) {
    return {
      status: 409,
      code: error.code,
      message: 'Wallet cannot authorize these payment terms.',
    };
  }
  return null;
}

/** Supply payment-specific safe projections while the shared HTTP boundary owns response delivery and logging. */
@Catch()
export class PaymentExceptionFilter extends HttpExceptionFilter {
  /** Keep payment identity privacy and request-key recovery guidance for every unclassified dependency outcome. */
  protected override mapFailure(error: unknown): HttpFailure {
    if (
      error instanceof AuthenticationError &&
      error.code === 'INVALID_CREDENTIALS'
    ) {
      return {
        status: 401,
        code: error.code,
        message: error.message,
        authenticationScheme: 'Bearer',
      };
    }
    const financialFailure =
      error instanceof WalletError ? walletFailure(error) : null;
    if (financialFailure) {
      return financialFailure;
    }
    const code =
      error instanceof PaymentError ? error.code : 'PAYMENT_UNAVAILABLE';
    const description =
      error instanceof PaymentError
        ? paymentErrorDescription(error.reason)
        : undefined;
    return {
      ...paymentFailures[code],
      code,
      ...(description === undefined ? {} : { message: description }),
    };
  }
}
