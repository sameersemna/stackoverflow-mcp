// @ts-check
/**
 * Flat ESLint configuration.
 *
 * Source is linted with the **type-aware** `strictTypeChecked` and
 * `stylisticTypeChecked` rule sets from typescript-eslint, because most of the
 * bugs this project has fixed were type-level or async-level mistakes that
 * non-type-aware linting cannot see (floating promises, unsafe `any` from
 * `JSON.parse`, unhandled rejections in fire-and-forget callbacks).
 *
 * Two tsconfigs are referenced: `tsconfig.json` builds the shipped source and
 * deliberately excludes `src/__tests__`, while `tsconfig.test.json` includes
 * the tests. Passing both keeps every linted file inside a project, which
 * type-aware linting requires.
 *
 * The test tree relaxes a handful of rules that are counter-productive when the
 * point of the code is to construct deliberately malformed input.
 */
import js from "@eslint/js"
import globals from "globals"
import tseslint from "typescript-eslint"

export default tseslint.config(
  { ignores: ["build/**", "coverage/**", "node_modules/**", "scripts/legacy/**"] },

  // Non-TypeScript files (scripts, config files) get plain recommended rules.
  {
    files: ["**/*.js", "**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
  },

  {
    files: ["src/**/*.ts"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        project: ["./tsconfig.json", "./tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The server must never write to stdout: stdout is the MCP stdio
      // transport's data channel, so a stray console.log corrupts the protocol.
      "no-console": "error",

      // Promise handling is load-bearing here. Every floating promise in a
      // long-lived server becomes an unhandled rejection at 3am.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/return-await": ["error", "in-try-catch"],
      "@typescript-eslint/require-await": "error",

      // Anything crossing the network or the filesystem is untrusted.
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",

      // Prefer explicit, greppable code.
      "@typescript-eslint/explicit-function-return-type": [
        "error",
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],

      // Unused symbols are always a mistake, but a leading underscore is an
      // established signal for "kept for signature compatibility".
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "all",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },

  {
    files: ["src/__tests__/**/*.ts"],
    rules: {
      // Tests print diagnostics, and jest's own reporters are noisy on purpose.
      "no-console": "off",
      // Building deliberately-invalid values (NaN, wrong enums) is the point.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/unbound-method": "off",
      // Fixtures are often intentionally unused beyond type checking.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { args: "none", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      // A mock stands in for an async API and must keep that signature, so the
      // absence of an `await` inside it says nothing about the real code.
      "@typescript-eslint/require-await": "off",
      // Suites build values and then read them back defensively; an optional
      // chain there documents "this may be missing" rather than guarding a bug.
      "@typescript-eslint/no-unnecessary-condition": "off",
    },
  },

  {
    // Test helpers whose single type parameter is a deliberate caller assertion
    // (`parseToolJson<T>`, `toolStructured<T>`): the parameter is the point, so
    // the rule that calls one-use type parameters unnecessary does not apply.
    files: ["src/__tests__/helpers/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unnecessary-type-parameters": "off",
    },
  }
)
