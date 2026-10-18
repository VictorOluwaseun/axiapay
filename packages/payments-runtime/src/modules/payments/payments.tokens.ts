/** Runtime identities keep persistence and adapter registration private to payment composition. */
export const PAYMENTS = Object.freeze({
  repository: Symbol('PaymentRepository'),
  recoveryRepository: Symbol('PaymentRecoveryRepository'),
  providers: Symbol('PaymentProviders'),
  clock: Symbol('PaymentClock'),
  featurePolicy: Symbol('PaymentFeaturePolicy'),
});
