/** Runtime identities for replaceable ports; business contracts remain framework independent. */
export const AUTHENTICATION = Object.freeze({
  repository: Symbol('AuthenticationRepository'),
  sessionIdentityCache: Symbol('SessionIdentityCache'),
  sessionCacheInvalidations: Symbol('SessionCacheInvalidationRepository'),
  codeRedemption: Symbol('CodeRedemptionRepository'),
  devices: Symbol('DeviceAuthenticationRepository'),
  deviceSignatures: Symbol('DeviceSignatures'),
  passwords: Symbol('PasswordHasher'),
  secrets: Symbol('AuthenticationSecrets'),
  codeDelivery: Symbol('AuthenticationCodeDelivery'),
  clock: Symbol('AuthenticationClock'),
});
