/** Runtime identities for replaceable ports; business contracts remain framework independent. */
export const AUTHENTICATION = Object.freeze({
  repository: Symbol('AuthenticationRepository'),
  devices: Symbol('DeviceAuthenticationRepository'),
  deviceSignatures: Symbol('DeviceSignatures'),
  passwords: Symbol('PasswordHasher'),
  secrets: Symbol('AuthenticationSecrets'),
  codeDelivery: Symbol('AuthenticationCodeDelivery'),
  clock: Symbol('AuthenticationClock'),
});
