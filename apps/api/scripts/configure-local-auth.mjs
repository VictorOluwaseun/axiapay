/** Provision a persistent local OTP key without replacing configured credentials or printing secrets. */
import { randomBytes } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';

const environmentPath = new URL('../.env', import.meta.url);
const content = await readFile(environmentPath, 'utf8');
if (/^NODE_ENV\s*=\s*production\s*$/m.test(content)) {
  throw new Error('Local authentication setup cannot configure production.');
}
const current = /^AUTH_CODE_SECRET=(.*)$/m.exec(content)?.[1]?.trim();
if (current && !/^[a-fA-F0-9]{64}$/.test(current)) {
  throw new Error('AUTH_CODE_SECRET already has a value. Review it manually.');
}
if (!current) {
  const entry = `AUTH_CODE_SECRET=${randomBytes(32).toString('hex')}`;
  const updated = /^AUTH_CODE_SECRET=.*$/m.test(content)
    ? content.replace(/^AUTH_CODE_SECRET=.*$/m, entry)
    : `${content.trimEnd()}\n${entry}\n`;
  await writeFile(environmentPath, updated, { mode: 0o600 });
}
await chmod(environmentPath, 0o600);
console.info(
  'Local authentication key is configured. Its value was not printed.',
);
