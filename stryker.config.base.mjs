// Shared Stryker settings. Each package spreads this, appends its own mutate
// exclusions and sets its own break threshold.
export default {
  testRunner: "vitest",
  coverageAnalysis: "perTest",
  reporters: ["progress", "clear-text"],
  // Not production code, so never mutated in any package.
  mutate: ["*.ts", "!*.test.ts", "!vitest.config.ts"],
};
