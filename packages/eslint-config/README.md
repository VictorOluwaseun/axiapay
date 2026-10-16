# `@repo/eslint-config`

Shared ESLint presets for this workspace.

- `@repo/eslint-config/node-service` exports `nodeServiceConfig`, the common Node/TypeScript policy for API, worker and payments runtime code.
- `@repo/eslint-config/base`, `/next-js` and `/react-internal` retain the existing web presets.

Node service consumers use a thin package-local entry point so source globs and ignored files remain relative to that package:

```js
/** Apply the Node service lint policy to this package. */
export { nodeServiceConfig as default } from "@repo/eslint-config/node-service";
```

The Node service preset owns the current architecture restrictions, repository contract exceptions, required braces, flat control flow and TypeScript checks. It does not load the web preset's warning-only plugin. Composition modules can wire concrete implementations; services and other workflow code consume repository contracts.

This package owns the parser/plugin dependencies it imports. Node service consumers retain their existing ESLint and TypeScript versions. The existing shared globals version has the same Node globals as the former per-application version; effective-config comparison verifies that the extraction preserves behavior.

`packages/payments-runtime/tests/e2e/repository-boundaries.spec.ts` exercises the API, worker and payments runtime entry points. Run their normal lint commands and that suite when changing this preset. Workspace dependencies let Turbo account for shared policy changes in the task graph.
