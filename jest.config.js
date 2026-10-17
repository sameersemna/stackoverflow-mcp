/**
 * Jest configuration.
 *
 * The `globals['ts-jest']` block that used to live here was deprecated and printed
 * three warnings per run; the same options are read from `transform`, which is where
 * ts-jest now expects them (docs/adr/0005-test-runner.md).
 *
 * `jest-ts-webcompat-resolver` maps `.js` specifiers in imports back to the `.ts`
 * sources, which is required because the project compiles with `NodeNext` resolution
 * and writes its imports with explicit extensions.
 */
export default {
  preset: "ts-jest/presets/default-esm",
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        useESM: true,
        tsconfig: "tsconfig.test.json",
      },
    ],
  },
  testEnvironment: "node",
  testMatch: ["**/src/__tests__/**/*.test.ts"],
  collectCoverageFrom: ["src/**/*.ts"],
  coveragePathIgnorePatterns: ["/node_modules/", "__tests__"],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "lcov"],
  // Ratcheted just below the level reached in Phase 8, so a regression fails the
  // build while ordinary refactoring still has room to move. `cli.ts` (process
  // entry point) and `src/transports/http.ts` (driven by `npm run smoke`) are
  // covered by the smoke test rather than by jest, so they are not thresholded
  // per-file here; the global floor still includes them.
  coverageThreshold: {
    global: { statements: 80, branches: 70, functions: 80, lines: 80 },
    "./src/core/": { statements: 85, branches: 75, functions: 90, lines: 85 },
    "./src/stackexchange/": { statements: 90, branches: 80, functions: 90, lines: 90 },
    "./src/format/": { statements: 90, branches: 80, functions: 85, lines: 90 },
  },
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
  resolver: "jest-ts-webcompat-resolver",
}
