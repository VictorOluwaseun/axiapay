import type { InsuredProfile } from './insurance-application.js';

/** Stable full-profile correlation survives PostgreSQL JSONB key ordering; it is neither a credential nor a signature. */
export function insuredProfileFingerprint(profile: InsuredProfile): string {
  const legacy = [
    profile.fullName,
    profile.dateOfBirth ?? null,
    profile.phoneNumber ?? null,
    profile.email ?? null,
    profile.address ?? null,
    profile.identityNumber ?? null,
    profile.assetReference ?? null,
  ];
  const additional = [
    'nextOfKinName',
    'nextOfKinPhoneNumber',
    'occupation',
    'engineCapacityBand',
    'chassisNumber',
    'vehicleMake',
    'vehicleModel',
    'vehicleColour',
    'manufactureYear',
    'state',
    'localGovernmentArea',
  ] as const;
  const provided = additional
    .filter((field) => profile[field] !== undefined)
    .map((field) => [field, profile[field]]);
  return JSON.stringify(provided.length === 0 ? legacy : [...legacy, provided]);
}
