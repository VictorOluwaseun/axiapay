/** Enforce TypeScript correctness, flat control flow, and inward layer dependencies. */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

const storageImports = ['kysely', 'kysely/*', 'pg', 'ioredis', 'bullmq'];
const outerImports = [
  ...storageImports,
  '@nestjs/*',
  'nestjs-pino',
  'zod',
  '**/infrastructure/**',
  '**/delivery/**',
  '**/bootstrap/**',
];
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '**/*.generated.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: { globals: globals.node },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'IfStatement IfStatement',
          message:
            'Use guard clauses or focused functions instead of nested if statements.',
        },
      ],
    },
  },
  {
    files: ['src/**/domain/**/*.ts', 'src/**/application/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [...outerImports] }],
    },
  },
  {
    files: ['src/**/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [...outerImports, '**/application/**'] },
      ],
    },
  },
  {
    files: ['src/**/delivery/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [...storageImports, '**/data-sources/**'] },
      ],
    },
  },
);
