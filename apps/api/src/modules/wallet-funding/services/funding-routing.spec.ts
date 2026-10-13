/** Validate deployment errors that could ambiguously route money or mix financial realms. */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FundingRoute } from '../ports/funding-adapter.js';
import { validateFundingRoutes } from './funding-routing.js';

/** Build a disabled network capability; route validation must never submit or verify money. */
function route(): FundingRoute {
  return {
    adapterId: 'collection-account',
    acceptsNewRequests: true,
    option: {
      id: 'checkout',
      displayName: 'Hosted checkout',
      currency: 'NGN',
      minimumAmountMinorUnits: 1n,
      maximumAmountMinorUnits: 10000n,
    },
    adapter: {
      partnerAccountId: randomUUID(),
      environment: 'test',
      /** Any network operation during registration is a contract violation. */
      async initialize() {
        throw new Error('No submission during configuration');
      },
      /** Any network operation during registration is a contract violation. */
      async verify() {
        throw new Error('No verification during configuration');
      },
    },
  };
}

describe('funding route safety', () => {
  it('accepts no adapters and multiple options bound to one stable capability', () => {
    const first = route();
    expect(() => validateFundingRoutes([])).not.toThrow();
    expect(() =>
      validateFundingRoutes([
        first,
        {
          ...first,
          acceptsNewRequests: false,
          option: { ...first.option, id: 'retired-checkout' },
        },
      ]),
    ).not.toThrow();
  });
  it('rejects duplicate option identity and reused account identity across adapters', () => {
    const first = route();
    expect(() => validateFundingRoutes([first, first])).toThrow(
      'INVALID_FUNDING',
    );
    expect(() =>
      validateFundingRoutes([
        first,
        {
          ...first,
          adapterId: 'other-collection',
          option: { ...first.option, id: 'other-checkout' },
        },
      ]),
    ).toThrow('INVALID_FUNDING');
  });
  it('rejects one adapter identity bound to two accounts or environments', () => {
    const first = route();
    const second = {
      ...route(),
      option: { ...first.option, id: 'other-checkout' },
    };
    expect(() => validateFundingRoutes([first, second])).toThrow(
      'INVALID_FUNDING',
    );
    expect(() =>
      validateFundingRoutes([
        first,
        { ...second, adapter: { ...first.adapter, environment: 'live' } },
      ]),
    ).toThrow('INVALID_FUNDING');
  });
  it('rejects impossible amount limits and malformed stable identifiers', () => {
    const first = route();
    expect(() =>
      validateFundingRoutes([
        {
          ...first,
          option: { ...first.option, minimumAmountMinorUnits: 10001n },
        },
      ]),
    ).toThrow('INVALID_FUNDING');
    expect(() =>
      validateFundingRoutes([
        { ...first, option: { ...first.option, minimumAmountMinorUnits: 0n } },
      ]),
    ).toThrow();
    expect(() =>
      validateFundingRoutes([{ ...first, adapterId: 'adapter\n' }]),
    ).toThrow('INVALID_FUNDING');
  });
});
