/** Shared backend lint policy: enforce TypeScript correctness, flat control flow and architectural boundaries for API, worker and backend packages. */
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

const storageImports = ["kysely", "kysely/*", "pg", "ioredis", "bullmq"];
/** Keep concrete HTTP clients inside infrastructure and provider adapters. */
const httpClientImports = ["axios", "axios/*"];
const transportImports = [
  "**/validation/**",
  "**/pipes/**",
  "**/controllers/**",
  "**/dtos/**",
  "**/guards/**",
  "**/filters/**",
  "**/interceptors/**",
  "**/types/**",
];
const concreteImports = [
  "**/adapters/**",
  "**/infrastructure/**",
  "**/data-sources/**",
  "**/providers/**",
  "**/security/**",
  // Restrict repository implementations regardless of file extension; keep contracts available to workflow code.
  "**/repositories/*",
  "!**/repositories/contracts",
  "!**/repositories/contracts/**",
  "**/bootstrap/**",
];
const frameworkImports = [
  "@nestjs/*",
  "nestjs-pino",
  "class-validator",
  "class-transformer",
  "zod",
];

/** Apply the backend policy relative to the consuming package; modules retain composition access and workflows use repository contracts. */
export const backendConfig = tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "**/*.generated.ts"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: { globals: globals.node },
    rules: {
      curly: ["error", "all"],
      "no-restricted-syntax": [
        "error",
        {
          selector: "IfStatement IfStatement",
          message:
            "Use guard clauses or focused functions instead of nested if statements.",
        },
      ],
    },
  },
  {
    files: [
      "src/**/usecases/**/*.ts",
      "src/**/processors/**/*.ts",
      "src/**/ports/**/*.ts",
      "src/**/repositories/contracts/**/*.ts",
      "src/shared/contracts/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...storageImports,
            ...httpClientImports,
            ...frameworkImports,
            ...transportImports,
            ...concreteImports,
            "**/services/**",
          ],
        },
      ],
    },
  },
  {
    files: ["src/**/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...storageImports,
            ...httpClientImports,
            ...frameworkImports,
            ...transportImports,
            ...concreteImports,
            "**/services/**",
            "**/usecases/**",
            "**/ports/**",
            "**/repositories/**",
          ],
        },
      ],
    },
  },
  {
    files: ["src/**/services/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@nestjs/common",
              importNames: [
                "ValidationPipe",
                "ParseUUIDPipe",
                "ParseIntPipe",
                "ParseFloatPipe",
                "ParseBoolPipe",
                "ParseArrayPipe",
                "ParseEnumPipe",
                "ParseDatePipe",
              ],
              message:
                "Validate untrusted input in DTOs/pipes or an entry-point wrapper before calling service logic.",
            },
          ],
          patterns: [
            ...storageImports,
            ...httpClientImports,
            "class-validator",
            "class-validator/*",
            "class-transformer",
            "class-transformer/*",
            ...transportImports,
            ...concreteImports,
          ],
        },
      ],
    },
  },
  {
    files: [
      "src/**/controllers/**/*.ts",
      "src/**/guards/**/*.ts",
      "src/**/filters/**/*.ts",
      "src/**/interceptors/**/*.ts",
      "src/**/dtos/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...storageImports,
            ...httpClientImports,
            ...concreteImports,
            "**/repositories/**",
            "**/usecases/**",
          ],
        },
      ],
    },
  },
  {
    files: ["src/**/repositories/*.ts", "src/**/data-sources/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...transportImports,
            "**/services/**",
            "**/usecases/**",
            "bullmq",
          ],
        },
      ],
    },
  },
);
