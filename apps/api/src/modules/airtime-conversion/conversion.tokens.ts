/** Private injection tokens keep storage and optional provider capabilities out of transport contracts. */
export const CONVERSION = {
  repository: Symbol('ConversionRepository'),
  routes: Symbol('ConversionRoutes'),
} as const;
