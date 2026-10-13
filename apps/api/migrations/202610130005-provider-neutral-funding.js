/** Preserve existing funding history while replacing vendor enums with explicit adapter and option identities. */
import { sql } from 'kysely';

/** Backfill only the new option identity; accepted amounts, bindings, fingerprints and ledger receipts are unchanged. */
export async function up(database) {
  await sql`
    alter table wallet_funding_requests drop constraint wallet_funding_requests_partner_check;
    alter table wallet_funding_requests add constraint wallet_funding_adapter_identity
      check (partner ~ '^[a-z][a-z0-9-]{0,63}$');
    alter table wallet_funding_requests add column funding_option_id text;
    -- The migrator owns this transaction. Restore protection before any application writes can resume.
    alter table wallet_funding_requests disable trigger protect_funding_request;
    update wallet_funding_requests set funding_option_id = partner || '-checkout';
    alter table wallet_funding_requests enable trigger protect_funding_request;
    alter table wallet_funding_requests alter column funding_option_id set not null;
    alter table wallet_funding_requests add constraint wallet_funding_option_identity
      check (funding_option_id ~ '^[a-z][a-z0-9-]{0,63}$');
    comment on column wallet_funding_requests.partner is 'Stable adapter binding ID; legacy column name retained for financial history compatibility.';
  `.execute(database);
}
