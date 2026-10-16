import type { InsuredProfile } from './insurance-application.js';

/** Stable full-profile correlation survives PostgreSQL JSONB key ordering; it is neither a credential nor a signature. */
export function insuredProfileFingerprint(profile: InsuredProfile): string {
  return JSON.stringify([
    profile.fullName,
    profile.dateOfBirth ?? null,
    profile.phoneNumber ?? null,
    profile.email ?? null,
    profile.address ?? null,
    profile.identityNumber ?? null,
    profile.assetReference ?? null,
  ]);
}
