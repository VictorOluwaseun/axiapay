import { WalletError } from './wallet-error.js';

/** PostgreSQL signed bigint bound; arithmetic is validated before persistence. */
export const maximumMinorUnits = 9_223_372_036_854_775_807n;

/** Exact positive money in the currency's minor units; no conversion or implicit rounding. */
export interface Money {
  readonly amountMinorUnits: bigint;
  readonly currency: string;
}

/** Validate a currency identifier; enabling products/currencies remains an application policy. */
export function assertCurrency(currency: string): void {
  if (!/^[A-Z]{3}$/.test(currency)) throw new WalletError('INVALID_CURRENCY');
}

/** Construct a bounded amount without accepting floating-point input. */
export function money(amountMinorUnits: bigint, currency: string): Money {
  assertCurrency(currency);
  if (
    typeof amountMinorUnits !== 'bigint' ||
    amountMinorUnits <= 0n ||
    amountMinorUnits > maximumMinorUnits
  )
    throw new WalletError('INVALID_AMOUNT');
  return Object.freeze({ amountMinorUnits, currency });
}

/** Reject missing, oversized, or whitespace-padded identities before acquiring database locks. */
export function assertReference(reference: string): void {
  if (!reference || reference.length > 200 || reference.trim() !== reference)
    throw new WalletError('INVALID_REFERENCE');
}
