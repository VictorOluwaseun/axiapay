/** First-party explanations for provider compatibility, protocol and evidence failures. These fixed messages contain no submitted values, credentials or raw upstream text. */
const paymentErrorDescriptions = Object.freeze({
  SERVICE_NOT_SUPPORTED:
    'The selected provider does not support this payment service.',
  PROVIDER_ROUTE_MISMATCH:
    'The selected provider account does not match the payment route.',
  NGN_CURRENCY_REQUIRED: 'This airtime provider requires amounts in NGN.',
  PRODUCT_NOT_SUPPORTED:
    'The selected airtime product is not supported by this provider.',
  NETWORK_PRODUCT_MISMATCH:
    'The selected mobile network does not match the airtime product.',
  RECIPIENT_REQUIRED:
    'A recipient phone number is required for this airtime payment.',
  NIGERIAN_RECIPIENT_REQUIRED:
    'Use a Nigerian recipient phone number in +234 format for this airtime payment.',
  EXECUTION_CLAIM_MISSING:
    'The payment has no saved execution claim, so a provider request reference cannot be created.',
  PAYMENT_ID_MISMATCH: 'The provider result refers to a different payment.',
  PAYMENT_TERMS_MISMATCH:
    'The provider result does not match the accepted payment terms.',
  PROVIDER_REQUEST_MISMATCH:
    'The provider response is missing the expected request reference or refers to a different request.',
  PROVIDER_RECIPIENT_MISMATCH:
    'The recipient confirmed by the provider does not match this payment.',
  PROVIDER_AMOUNT_MISMATCH:
    'The amount confirmed by the provider does not match the quoted airtime amount.',
  PROVIDER_UNIT_PRICE_MISMATCH:
    'The provider unit price does not match the quoted airtime amount.',
  PROVIDER_PURCHASE_AMOUNT_MISMATCH:
    'The reported provider purchase amount does not match the quoted airtime amount.',
  PROVIDER_PRODUCT_MISMATCH:
    'The product confirmed by the provider does not match the selected airtime product.',
  PROVIDER_CURRENCY_MISMATCH:
    'The currency confirmed by the provider does not match the payment currency.',
  PROVIDER_QUANTITY_MISMATCH:
    'The provider response does not confirm exactly one airtime purchase.',
  PROVIDER_SERVICE_MISMATCH:
    'The provider response does not describe an airtime recharge.',
  PROVIDER_AMOUNT_INVALID:
    'The provider amount is not an exact decimal with supported precision.',
  PROVIDER_AMOUNT_OUT_OF_RANGE:
    'The provider amount must be positive and within the supported monetary range.',
  PROVIDER_TRANSACTION_REFERENCE_INVALID:
    'The provider transaction reference is missing or invalid.',
  PROVIDER_REFUND_REFERENCE_INVALID:
    'The provider refund reference is missing or invalid.',
  PROVIDER_RESPONSE_INVALID_OBJECT:
    'The payment provider response must contain a JSON object.',
  PROVIDER_RESPONSE_INVALID_JSON: 'The payment provider returned invalid JSON.',
  PROVIDER_RESPONSE_EMPTY: 'The payment provider returned an empty response.',
  PROVIDER_RESPONSE_TOO_LARGE:
    'The payment provider response exceeded the supported size limit.',
  PROVIDER_AUTHENTICATION_FAILED:
    'The payment provider did not accept the configured credentials or account permissions. The payment outcome remains unconfirmed.',
  PROVIDER_RATE_LIMITED:
    'The payment provider is rate limiting requests. Check the existing payment status before trying again.',
  PROVIDER_HTTP_ERROR:
    'The payment provider returned an HTTP error. The payment outcome remains unconfirmed; check the existing payment status.',
  PROVIDER_TIMEOUT:
    'The payment provider request timed out. The outcome remains unconfirmed; check the existing payment status.',
  PROVIDER_CONNECTION_FAILED:
    'The payment provider connection failed. The outcome remains unconfirmed; check the existing payment status.',
});

/** Stable diagnostic classifications, independent of broad public payment error codes and HTTP status. */
export type PaymentErrorReason = keyof typeof paymentErrorDescriptions;

/** Select only a declared safe description, including when a thrown object was modified after construction. Arbitrary error text is never a public message. */
export function paymentErrorDescription(reason: unknown): string | undefined {
  if (
    typeof reason !== 'string' ||
    !Object.hasOwn(paymentErrorDescriptions, reason)
  ) {
    return undefined;
  }
  return paymentErrorDescriptions[reason as PaymentErrorReason];
}
