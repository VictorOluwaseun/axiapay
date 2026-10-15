/** Verify upgrading authentication preserves existing credentials/sessions/codes and enforces recovery bindings. */
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { startWalletTestDatabase } from '../support/wallet-test-database.js';
import { PostgresAuthenticationRepository } from '../../src/modules/authentication/repositories/postgres-authentication.repository.js';

it('preserves established authentication when upgrading to password recovery', async () => {
  const baseline = await startWalletTestDatabase(
    '202610140009-airtime-conversion',
  );
  try {
    const accountId = randomUUID();
    const contact = { kind: 'email' as const, value: 'existing@example.com' };
    const now = new Date('2030-01-01T00:00:00Z');
    await baseline.administrator
      .insertInto('auth_accounts')
      .values({
        id: accountId,
        contact_kind: contact.kind,
        contact_value: contact.value,
        password_hash: 'existing-argon2-hash',
        created_at: now,
        verified_at: now,
        disabled_at: null,
      })
      .execute();
    await baseline.administrator
      .insertInto('auth_accounts')
      .values({
        id: randomUUID(),
        contact_kind: 'email',
        contact_value: 'later@example.com',
        password_hash: null,
        created_at: now,
        verified_at: now,
        disabled_at: null,
      })
      .execute();
    const sessionId = randomUUID();
    await baseline.administrator
      .insertInto('auth_sessions')
      .values({
        id: sessionId,
        account_id: accountId,
        token_digest: 'b'.repeat(64),
        created_at: now,
        expires_at: new Date(now.getTime() + 86_400_000),
        revoked_at: null,
        device_credential_id: null,
        primary_authenticated_at: now,
      })
      .execute();
    const loginId = randomUUID();
    const signupId = randomUUID();
    const earlierUnknownLogin = randomUUID();
    for (const [id, purpose, createdAt] of [
      [loginId, 'login', now],
      [signupId, 'signup', now],
      [earlierUnknownLogin, 'login', new Date(now.getTime() - 1000)],
    ] as const) {
      await baseline.administrator
        .insertInto('auth_challenges')
        .values({
          id,
          purpose,
          contact_kind: contact.kind,
          contact_value:
            id === earlierUnknownLogin ? 'later@example.com' : contact.value,
          password_hash: null,
          code_digest: 'a'.repeat(64),
          created_at: createdAt,
          expires_at: new Date(now.getTime() + 300_000),
          attempts: 0,
          status: 'ready',
        })
        .execute();
    }
    const result = await baseline.migrator.migrateToLatest();
    if (result.error) {
      throw result.error;
    }
    const repository = new PostgresAuthenticationRepository(
      baseline.administrator,
    );
    expect(await repository.findAccount(contact)).toMatchObject({
      id: accountId,
      credentialVersion: 0,
      passwordHash: 'existing-argon2-hash',
    });
    expect(
      await repository.findSessionIdentity('b'.repeat(64), now),
    ).toMatchObject({ id: accountId });
    const rows = await baseline.administrator
      .selectFrom('auth_challenges')
      .selectAll()
      .execute();
    expect(rows.find((row) => row.id === loginId)).toMatchObject({
      account_id: accountId,
      credential_version: 0,
      status: 'ready',
    });
    expect(rows.find((row) => row.id === signupId)).toMatchObject({
      account_id: null,
      credential_version: null,
      status: 'ready',
    });
    expect(rows.find((row) => row.id === earlierUnknownLogin)).toMatchObject({
      account_id: null,
      credential_version: null,
      status: 'ready',
    });
    await expect(
      baseline.administrator
        .updateTable('auth_challenges')
        .set({ credential_version: null })
        .where('id', '=', loginId)
        .execute(),
    ).rejects.toThrow('auth_challenges_identity_version');
    await expect(
      baseline.administrator
        .updateTable('auth_challenges')
        .set({ purpose: 'arbitrary' })
        .where('id', '=', loginId)
        .execute(),
    ).rejects.toThrow('auth_challenges_purpose');
    await expect(
      baseline.administrator
        .updateTable('auth_accounts')
        .set({ credential_version: -1 })
        .where('id', '=', accountId)
        .execute(),
    ).rejects.toThrow();
    expect(
      (
        await baseline.administrator
          .selectFrom('auth_sessions')
          .selectAll()
          .executeTakeFirstOrThrow()
      ).revoked_at,
    ).toBeNull();
  } finally {
    await baseline.stop();
  }
});
