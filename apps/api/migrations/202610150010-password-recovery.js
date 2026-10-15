import { sql } from 'kysely';

/** Add recovery purpose and version bindings; preserve accounts, sessions, and valid existing login challenges. */
export async function up(database) {
  await sql`
    alter table auth_accounts add column credential_version integer not null default 0 check (credential_version >= 0);
    alter table auth_challenges alter column purpose type varchar(14);
    alter table auth_challenges drop constraint auth_challenges_purpose;
    alter table auth_challenges add constraint auth_challenges_purpose check (purpose in ('signup', 'login', 'password-reset'));
    alter table auth_challenges add column account_id uuid references auth_accounts(id);
    alter table auth_challenges add column credential_version integer check (credential_version >= 0);
    alter table auth_challenges add constraint auth_challenges_identity_version check ((account_id is null) = (credential_version is null));
    update auth_challenges as challenge set account_id = account.id, credential_version = account.credential_version
      from auth_accounts as account
      where challenge.purpose = 'login' and challenge.contact_kind = account.contact_kind
        and challenge.contact_value = account.contact_value and account.created_at <= challenge.created_at;
  `.execute(database);
}
