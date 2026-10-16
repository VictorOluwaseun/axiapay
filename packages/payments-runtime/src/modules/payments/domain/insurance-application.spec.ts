/** Verify requested coverage arithmetic for boundary-validated dates; HTTP date syntax is exercised by API contract tests. */
import { describe, expect, it } from 'vitest';
import { requestedCoverageEnd } from './insurance-application.js';

describe('requested insurance coverage period', () => {
  it.each([
    ['2024-02-28', 2, '2024-03-01'],
    ['2023-02-28', 1, '2023-03-01'],
    ['2026-12-31', 1, '2027-01-01'],
    ['9999-12-30', 1, '9999-12-31'],
  ] as const)(
    'derives the exclusive end from %s plus %s days',
    (start, days, expectedEnd) => {
      expect(requestedCoverageEnd(start, days)).toBe(expectedEnd);
    },
  );

  it('rejects a calculated end outside the supported calendar', () => {
    expect(() => requestedCoverageEnd('9999-12-31', 1)).toThrow(
      expect.objectContaining({ code: 'INVALID_PAYMENT' }),
    );
  });
});
