# Database migrations

No application tables are defined yet. Add reviewed timestamp-prefixed `.js` ESM migrations exporting `up(db)` and, when safe and meaningful, `down(db)`. Use Kysely schema operations or SQL. Migration files must remain independent of current domain code.

After building, `pnpm --filter @axiapay/api db:migrate` applies pending migrations using `DATABASE_URL`. The runner resolves this directory relative to its compiled location. It never runs during API startup and provides no automatic rollback command. `db:types` regenerates infrastructure types after schema changes; review exact monetary mappings.
