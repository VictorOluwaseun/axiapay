import { createHash, createPublicKey, verify } from 'node:crypto';
import type { DeviceSignatures } from '../ports/device-signatures.js';
import { AuthenticationError } from '../domain/authentication-error.js';

/** Use Node's standard P-256/SHA-256 verification; these signatures prove key possession, not Android biometric attestation. */
export class NodeDeviceSignatures implements DeviceSignatures {
  /** Reject noncanonical encodings and enforce a single algorithm and public-key format. */
  readPublicKey(encoded: string) {
    try {
      const bytes = decodeBase64Url(encoded, 256);
      const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
      if (
        key.asymmetricKeyType !== 'ec' ||
        key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
      ) {
        throw new Error('Unsupported key.');
      }
      const canonical = key.export({ format: 'der', type: 'spki' });
      if (!canonical.equals(bytes)) {
        throw new Error('Noncanonical key.');
      }
      return {
        publicKey: encoded,
        fingerprint: createHash('sha256').update(canonical).digest('hex'),
      };
    } catch {
      throw new AuthenticationError(
        'INVALID_INPUT',
        'Use a base64url SPKI public key for ECDSA P-256.',
      );
    }
  }
  /** Clients sign the decoded bytes unchanged; purpose, device, expiry, and random server challenge are bound together. */
  createMessage(
    input: Parameters<DeviceSignatures['createMessage']>[0],
  ): string {
    return Buffer.from(
      JSON.stringify([
        'axiapay-device-auth-v1',
        input.purpose,
        input.challengeId,
        input.credentialId,
        input.nonce,
        input.expiresAt.toISOString(),
      ]),
      'utf8',
    ).toString('base64url');
  }
  /** Fail closed on invalid encoding or signature without returning cryptographic diagnostics. */
  verify(publicKey: string, message: string, signature: string): boolean {
    try {
      const key = createPublicKey({
        key: decodeBase64Url(publicKey, 256),
        format: 'der',
        type: 'spki',
      });
      return verify(
        'sha256',
        decodeBase64Url(message, 2048),
        { key, dsaEncoding: 'der' },
        decodeBase64Url(signature, 128),
      );
    } catch {
      return false;
    }
  }
}

/** Node decoders are permissive, so reject padding, alternative alphabets, and noncanonical trailing bits explicitly. */
function decodeBase64Url(value: string, maxLength: number): Buffer {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new Error('Invalid base64url.');
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) {
    throw new Error('Noncanonical base64url.');
  }
  return decoded;
}
