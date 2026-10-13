/** Private injection identities separate application contracts from concrete partner and PostgreSQL adapters. */
export const FUNDING = Object.freeze({
  repository: Symbol('FundingRepository'),
  routes: Symbol('FundingRoutes'),
});
