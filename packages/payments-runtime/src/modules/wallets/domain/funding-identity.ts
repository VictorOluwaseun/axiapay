import type { Money } from './money.js';

/** Canonical funding terms bind a movement to exactly one wallet and amount, independent of notification identity. */
export function fundingFingerprint(walletId: string, value: Money): string {
  return JSON.stringify([
    'funding',
    walletId,
    value.currency,
    value.amountMinorUnits.toString(),
  ]);
}
