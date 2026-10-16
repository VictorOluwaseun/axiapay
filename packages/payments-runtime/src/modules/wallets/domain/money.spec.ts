/** Exercise money boundaries and balanced posting invariants without storage dependencies. */
import { describe, expect, it } from 'vitest';
import { maximumMinorUnits, money } from './money.js';
import { assertBalancedJournal } from './journal.js';

describe('wallet money', () => {
  it('preserves amounts above the JavaScript safe-number range', () => {
    expect(money(9_007_199_254_740_993n, 'NGN').amountMinorUnits).toBe(
      9_007_199_254_740_993n,
    );
  });
  it.each([0n, -1n, maximumMinorUnits + 1n])(
    'rejects an invalid minor-unit amount %s',
    (amount) => {
      expect(() => money(amount, 'NGN')).toThrow('INVALID_AMOUNT');
    },
  );
  it('rejects floating-point runtime input and noncanonical currency', () => {
    expect(() => money(1.2 as unknown as bigint, 'NGN')).toThrow(
      'INVALID_AMOUNT',
    );
    expect(() => money(1n, 'ngn')).toThrow('INVALID_CURRENCY');
  });
  it('rejects a journal that creates money without a corresponding debit', () => {
    expect(() =>
      assertBalancedJournal({
        journalKind: 'transfer',
        currency: 'NGN',
        entries: [
          { accountId: 'sender', side: 'debit', amountMinorUnits: 10n },
          { accountId: 'recipient', side: 'credit', amountMinorUnits: 11n },
        ],
      }),
    ).toThrow('LEDGER_CONFIGURATION');
  });
});
