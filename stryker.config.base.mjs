// Shared Stryker settings. Each package spreads this, appends its own mutate
// exclusions and sets its own break threshold.
export default {
  testRunner: "vitest",
  coverageAnalysis: "perTest",
  // Test files import ../test-helpers, which escapes a sandboxed package root.
  inPlace: true,
  reporters: ["progress", "clear-text"],
  // Not production code, so never mutated in any package.
  mutate: ["*.ts", "!*.test.ts", "!vitest.config.ts"],
};
