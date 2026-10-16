/** Exercise the actual API, worker and shared-backend lint configurations against repository boundary regressions without writing fixture files. */
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const configurations = [
  ['API', '../../../../apps/api/'],
  ['shared backend', '../../'],
] as const;

const contractConsumers = [
  'src/modules/payments/services/boundary.ts',
  'src/modules/payments/usecases/boundary.ts',
  'src/modules/payments/processors/boundary.ts',
  'src/modules/payments/ports/boundary.ts',
  'src/modules/payments/repositories/contracts/boundary.ts',
  'src/shared/contracts/boundary.ts',
];

const concreteRepositories = [
  '../repositories/postgres-payment.repository',
  '../repositories/postgres-payment.repository.js',
  '../repositories/postgres-payment.repository.ts',
  '../repositories/wallet.repository.impl',
  '../repositories/postgres/payment.repository',
  '../repositories/contracts-old/payment.repository',
  '@axiapay/backend/modules/payments/repositories/postgres-payment.repository',
  '@axiapay/backend/modules/payments/repositories/postgres-payment.repository.js',
  '@axiapay/backend/modules/payments/repositories/postgres-payment.repository.ts',
];

const repositoryContracts = [
  '../repositories/contracts/payment.repository',
  '../repositories/contracts/payment.repository.js',
  '../repositories/contracts/payment.repository.ts',
  '../repositories/contracts/payments/payment.repository',
  '@axiapay/backend/modules/payments/repositories/contracts/payment.repository',
  '@axiapay/backend/modules/payments/repositories/contracts/payment.repository.js',
];

describe.each(configurations)(
  '%s repository import boundaries',
  (_name, path) => {
    const cwd = fileURLToPath(new URL(path, import.meta.url));
    // Multiple workspace configurations share one test process; resolve each parser from its own package.
    const linter = new ESLint({
      cwd,
      overrideConfig: [
        { languageOptions: { parserOptions: { tsconfigRootDir: cwd } } },
      ],
    });

    it.each(contractConsumers)(
      'rejects concrete repository imports in %s, including extensionless package imports',
      async (filePath) => {
        for (const modulePath of concreteRepositories) {
          const [result] = await linter.lintText(`import '${modulePath}';\n`, {
            filePath,
          });
          expect(result?.messages, `${filePath}: ${modulePath}`).toEqual([
            expect.objectContaining({ ruleId: 'no-restricted-imports' }),
          ]);
        }
      },
    );

    it.each(contractConsumers)(
      'allows repository contracts in %s',
      async (filePath) => {
        for (const modulePath of repositoryContracts) {
          const [result] = await linter.lintText(`import '${modulePath}';\n`, {
            filePath,
          });
          expect(result?.messages, `${filePath}: ${modulePath}`).toEqual([]);
        }
      },
    );

    it.each([
      "import type { Repository } from '@axiapay/backend/modules/payments/repositories/postgres-payment.repository'; export type { Repository };",
      "export { Repository } from '../repositories/postgres-payment.repository';",
      "export * from '@axiapay/backend/modules/payments/repositories/postgres-payment.repository';",
    ])('also rejects type imports and re-exports: %s', async (source) => {
      const [result] = await linter.lintText(source, {
        filePath: 'src/modules/payments/services/boundary.ts',
      });
      expect(result?.messages).toEqual([
        expect.objectContaining({ ruleId: 'no-restricted-imports' }),
      ]);
    });

    it.each([
      'src/modules/payments/domain/boundary.ts',
      'src/modules/payments/controllers/boundary.ts',
    ])('keeps all repositories outside %s', async (filePath) => {
      const [result] = await linter.lintText(
        "import '@axiapay/backend/modules/payments/repositories/contracts/payment.repository';\n",
        { filePath },
      );
      expect(result?.messages).toEqual([
        expect.objectContaining({ ruleId: 'no-restricted-imports' }),
      ]);
    });

    it('allows concrete repository wiring at the module composition boundary', async () => {
      const [result] = await linter.lintText(
        "import '@axiapay/backend/modules/payments/repositories/postgres-payment.repository';\n",
        { filePath: 'src/modules/payments/payments.module.ts' },
      );
      expect(result?.messages).toEqual([]);
    });
  },
);
