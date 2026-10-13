/** Validate canonical P-256 public keys and verify device signatures without leaking crypto SDK types into workflows. */
export interface DeviceSignatures {
  /** Accept only base64url DER SubjectPublicKeyInfo for ECDSA P-256; reject private, malformed, or unsupported keys. */
  readPublicKey(encoded: string): { publicKey: string; fingerprint: string };
  /** Encode an immutable, versioned, purpose-bound message with a random nonce supplied by the secrets port. */
  createMessage(input: {
    purpose: 'enroll' | 'login';
    challengeId: string;
    credentialId: string;
    nonce: string;
    expiresAt: Date;
  }): string;
  /** Verify SHA256withECDSA over decoded message bytes using an ASN.1 DER signature; return false for malformed proof. */
  verify(publicKey: string, message: string, signature: string): boolean;
}
