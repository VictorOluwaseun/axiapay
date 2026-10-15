/** Enforce TypeScript correctness, flat control flow, and the feature's responsibility boundaries. */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

const storageImports = ['kysely', 'kysely/*', 'pg', 'ioredis', 'bullmq'];
const transportImports = [
  '**/validation/**',
  '**/pipes/**',
  '**/controllers/**',
  '**/dtos/**',
  '**/guards/**',
  '**/filters/**',
  '**/interceptors/**',
  '**/types/**',
];
const concreteImports = [
  '**/infrastructure/**',
  '**/data-sources/**',
  '**/providers/**',
  '**/security/**',
  '**/repositories/*.js',
  '**/bootstrap/**',
];
const frameworkImports = [
  '@nestjs/*',
  'nestjs-pino',
  'class-validator',
  'class-transformer',
  'zod',
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
      curly: ['error', 'all'],
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
    files: [
      'src/**/usecases/**/*.ts',
      'src/**/ports/**/*.ts',
      'src/**/repositories/contracts/**/*.ts',
      'src/shared/contracts/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...storageImports,
            ...frameworkImports,
            ...transportImports,
            ...concreteImports,
            '**/services/**',
          ],
        },
      ],
    },
  },
  {
    files: ['src/**/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...storageImports,
            ...frameworkImports,
            ...transportImports,
            ...concreteImports,
            '**/services/**',
            '**/usecases/**',
            '**/ports/**',
            '**/repositories/**',
          ],
        },
      ],
    },
  },
  {
    files: ['src/**/services/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@nestjs/common',
              importNames: [
                'ValidationPipe',
                'ParseUUIDPipe',
                'ParseIntPipe',
                'ParseFloatPipe',
                'ParseBoolPipe',
                'ParseArrayPipe',
                'ParseEnumPipe',
                'ParseDatePipe',
              ],
              message:
                'Validate untrusted input in DTOs/pipes or an entry-point wrapper before calling service logic.',
            },
          ],
          patterns: [
            ...storageImports,
            'class-validator',
            'class-validator/*',
            'class-transformer',
            'class-transformer/*',
            ...transportImports,
            ...concreteImports,
          ],
        },
      ],
    },
  },
  {
    files: [
      'src/**/controllers/**/*.ts',
      'src/**/guards/**/*.ts',
      'src/**/filters/**/*.ts',
      'src/**/interceptors/**/*.ts',
      'src/**/dtos/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...storageImports,
            ...concreteImports,
            '**/repositories/**',
            '**/usecases/**',
          ],
        },
      ],
    },
  },
  {
    files: ['src/**/repositories/*.ts', 'src/**/data-sources/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...transportImports,
            '**/services/**',
            '**/usecases/**',
            'bullmq',
          ],
        },
      ],
    },
  },
);
