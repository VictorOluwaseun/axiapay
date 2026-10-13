/** Verify Android-compatible key and signature formats with independent standard crypto signing operations. */
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NodeDeviceSignatures } from './node-device-signatures.js';

const signatures = new NodeDeviceSignatures();
describe('device signature boundary', () => {
  it('accepts DER SHA256withECDSA over decoded server messages and rejects signing the encoded string', () => {
    const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const publicKey = key.publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64url');
    expect(signatures.readPublicKey(publicKey).fingerprint).toMatch(
      /^[a-f0-9]{64}$/,
    );
    const message = signatures.createMessage({
      purpose: 'login',
      challengeId: randomUUID(),
      credentialId: randomUUID(),
      nonce: 'test-nonce',
      expiresAt: new Date('2030-01-01'),
    });
    const valid = sign(
      'sha256',
      Buffer.from(message, 'base64url'),
      key.privateKey,
    ).toString('base64url');
    const encoded = sign(
      'sha256',
      Buffer.from(message),
      key.privateKey,
    ).toString('base64url');
    const raw = sign('sha256', Buffer.from(message, 'base64url'), {
      key: key.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    expect(signatures.verify(publicKey, message, valid)).toBe(true);
    expect(signatures.verify(publicKey, message, encoded)).toBe(false);
    expect(signatures.verify(publicKey, message, raw)).toBe(false);
    expect(signatures.verify(publicKey, message, valid + '=')).toBe(false);
    expect(signatures.verify(publicKey, message, 'malformed')).toBe(false);
    const altered = Buffer.from(
      JSON.stringify(['another-purpose']),
      'utf8',
    ).toString('base64url');
    expect(signatures.verify(publicKey, altered, valid)).toBe(false);
  });
  it('rejects private-key encodings, alternative curves, malformed keys, and padded base64', () => {
    const p256 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    const ed25519 = generateKeyPairSync('ed25519');
    const valid = p256.publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64url');
    const invalidKeys = [
      p256.privateKey
        .export({ format: 'der', type: 'pkcs8' })
        .toString('base64url'),
      p384.publicKey
        .export({ format: 'der', type: 'spki' })
        .toString('base64url'),
      ed25519.publicKey
        .export({ format: 'der', type: 'spki' })
        .toString('base64url'),
      valid + '=',
      'not-a-key',
      'A'.repeat(257),
    ];
    for (const key of invalidKeys) {
      expect(() => signatures.readPublicKey(key)).toThrow('ECDSA P-256');
    }
  });
});
