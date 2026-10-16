import type {
  InsuranceProductTerms,
  InsuredField,
} from '../../service-catalog/domain/insurance-product-terms.js';
import { PaymentError } from './payment.js';
import { insuredProfileFingerprint } from './insured-profile-fingerprint.js';

/** Typed personal/asset details; optional fields are accepted only when the selected product explicitly requests them. */
export interface InsuredProfile {
  readonly fullName: string;
  readonly dateOfBirth?: string;
  readonly phoneNumber?: string;
  readonly email?: string;
  readonly address?: string;
  readonly identityNumber?: string;
  readonly assetReference?: string;
}

/** Consented, eligible insurance application. Eligibility, payment, policy issuance and active coverage remain distinct facts. */
export interface InsuranceApplication {
  readonly id: string;
  readonly ownerId: string;
  readonly productId: string;
  readonly insuredProfile: InsuredProfile;
  readonly termsVersion: string;
  readonly acceptedTerms: true;
  readonly coverageStartsOn: string;
  readonly coverageEndsOn: string;
  readonly evidenceReference: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/** Validate exact calendar dates, preventing rollover, timezone guessing and non-date inputs. */
export function calendarDate(value: string): Date {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}(?![\s\S])/.test(value)
  ) {
    throw new PaymentError('INVALID_PAYMENT');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new PaymentError('INVALID_PAYMENT');
  }
  return parsed;
}

/** Construct an exclusive requested end date from operator-defined duration; actual issued-policy bounds must still be independently confirmed. */
export function requestedCoverageEnd(
  startsOn: string,
  durationDays: number,
): string {
  if (
    !Number.isInteger(durationDays) ||
    durationDays < 1 ||
    durationDays > 36_500
  ) {
    throw new PaymentError('PRODUCT_UNAVAILABLE');
  }
  const end = new Date(
    calendarDate(startsOn).getTime() + durationDays * 86_400_000,
  );
  const endDate = end.toISOString().slice(0, 10);
  calendarDate(endDate);
  return endDate;
}

/** Enforce product-specific required/allowed fields and birth-date eligibility on an adapter-validated profile. */
export function validatedInsuredProfile(
  profile: InsuredProfile,
  terms: InsuranceProductTerms,
  now: Date,
): InsuredProfile {
  const known: readonly InsuredField[] = [
    'fullName',
    'dateOfBirth',
    'phoneNumber',
    'email',
    'address',
    'identityNumber',
    'assetReference',
  ];
  const allowed = [
    ...terms.requiredInsuredFields,
    ...terms.optionalInsuredFields,
  ];
  if (
    !terms.requiredInsuredFields.includes('fullName') ||
    new Set(allowed).size !== allowed.length ||
    allowed.some((field) => !known.includes(field))
  ) {
    throw new PaymentError('PRODUCT_UNAVAILABLE');
  }
  // DTO class declarations can materialize omitted optional properties as undefined; only effective supplied values count as collected fields.
  if (
    Object.entries(profile).some(
      ([field, value]) =>
        value !== undefined && !allowed.includes(field as InsuredField),
    ) ||
    terms.requiredInsuredFields.some((field) => profile[field] === undefined)
  ) {
    throw new PaymentError('INVALID_PAYMENT');
  }
  for (const field of allowed) {
    if (field === 'dateOfBirth' && profile.dateOfBirth !== undefined) {
      assertBirthDateNotFuture(profile.dateOfBirth, now);
    }
  }
  return Object.fromEntries(
    known
      .filter((field) => profile[field] !== undefined)
      .map((field) => [field, profile[field]]),
  ) as unknown as InsuredProfile;
}

/** Birth dates cannot be in the future; no age/eligibility rule is invented here. */
function assertBirthDateNotFuture(value: string, now: Date): void {
  if (new Date(`${value}T00:00:00.000Z`).getTime() > now.getTime()) {
    throw new PaymentError('INVALID_PAYMENT');
  }
}

/** Prevent expired eligibility/consent evidence from authorizing a fresh wallet hold. */
export function assertInsuranceApplicationCurrent(
  application: InsuranceApplication,
  now: Date,
): void {
  if (application.expiresAt.getTime() <= now.getTime()) {
    throw new PaymentError('INSURANCE_APPLICATION_EXPIRED');
  }
}

/** Correlate underwriting evidence to the complete canonical submitted profile, terms and requested period; this is not a signature. */
export function insuranceApplicationFingerprint(
  productId: string,
  profile: InsuredProfile,
  termsVersion: string,
  startsOn: string,
  endsOn: string,
): string {
  return JSON.stringify([
    productId,
    insuredProfileFingerprint(profile),
    termsVersion,
    startsOn,
    endsOn,
  ]);
}
