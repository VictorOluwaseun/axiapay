import { argon2id, hash, verify } from 'argon2';
import { randomBytes } from 'node:crypto';
import type { PasswordHasher } from '../ports/authentication.ports.js';

/** Hash passwords with Argon2id and equalize missing-account verification with a randomly generated dummy hash. */
export class ArgonPasswordHasher implements PasswordHasher {
  /** Reuse one dummy hash per injected instance; it is never a real account credential. */
  private readonly dummyHash = this.hash(randomBytes(32).toString('base64url'));
  /** Use the documented Argon2id minimum of 19 MiB, two passes, and one lane. */
  hash(password: string): Promise<string> {
    return hash(password, {
      type: argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
  }
  /** Always perform an Argon2 comparison; null hashes can never authenticate. */
  async verify(password: string, encoded: string | null): Promise<boolean> {
    const matches = await verify(encoded ?? (await this.dummyHash), password);
    return encoded !== null && matches;
  }
}
