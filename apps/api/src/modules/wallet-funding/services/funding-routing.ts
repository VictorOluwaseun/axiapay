import { FundingError } from '../domain/funding.js';
import type { FundingRoute } from '../ports/funding-adapter.js';
import { money } from '@axiapay/backend/modules/wallets/domain/money';

/** Validate explicit routing configuration before serving requests; ambiguous options or reused clearing identities fail startup. */
export function validateFundingRoutes(routes: readonly FundingRoute[]): void {
  const optionIds = new Set<string>();
  const bindings = new Map<string, string>();
  const accounts = new Map<string, string>();
  for (const route of routes) {
    const { option, adapterId, adapter } = route;
    const binding = `${adapter.environment}:${adapter.partnerAccountId}`;
    const existingBinding = bindings.get(adapterId);
    const existingAccount = accounts.get(adapter.partnerAccountId);
    if (
      !/^[a-z][a-z0-9-]{0,63}(?![\s\S])/.test(option.id) ||
      !/^[a-z][a-z0-9-]{0,63}(?![\s\S])/.test(adapterId) ||
      !option.displayName.trim() ||
      option.displayName.length > 100 ||
      typeof route.acceptsNewRequests !== 'boolean' ||
      optionIds.has(option.id) ||
      (existingBinding !== undefined && existingBinding !== binding) ||
      (existingAccount !== undefined && existingAccount !== adapterId) ||
      !['test', 'live'].includes(adapter.environment) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/.test(
        adapter.partnerAccountId,
      )
    ) {
      throw new FundingError('INVALID_FUNDING');
    }
    money(option.minimumAmountMinorUnits, option.currency);
    money(option.maximumAmountMinorUnits, option.currency);
    if (option.minimumAmountMinorUnits > option.maximumAmountMinorUnits) {
      throw new FundingError('INVALID_FUNDING');
    }
    optionIds.add(option.id);
    bindings.set(adapterId, binding);
    accounts.set(adapter.partnerAccountId, adapterId);
  }
}
