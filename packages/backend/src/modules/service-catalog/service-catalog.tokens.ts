/** Explicit identity for private catalogue persistence; callers use the public feature service. */
export const SERVICE_CATALOG = Object.freeze({
  repository: Symbol('ServiceCatalogRepository'),
});
