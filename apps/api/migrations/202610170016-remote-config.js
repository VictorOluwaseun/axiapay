/** Store remotely changeable boolean flags separately from secrets; runtime applications receive read access only. */
export async function up(database) {
  await database.schema
    .createTable('remote_config_flags')
    .addColumn('key', 'text', (column) => column.primaryKey())
    .addColumn('enabled', 'boolean', (column) => column.notNull())
    .execute();

  await database
    .insertInto('remote_config_flags')
    .values([
      { key: 'authentication.signup.emailEnabled', enabled: true },
      { key: 'authentication.signup.phoneEnabled', enabled: true },
      { key: 'authentication.login.emailEnabled', enabled: true },
      { key: 'authentication.login.phoneEnabled', enabled: true },
    ])
    .execute();
}
